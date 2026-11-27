#!/bin/bash
# ============================================================================
# The rehearsal's watch: a backstop behind lima.yaml's forwarding rules
# ============================================================================
#   watch.sh WORK LIMACTL INSTANCE PERIOD ABORT_FREE_GIB
#
# lima.yaml is what keeps guest ports off the host; this loop only notices
# if that ever failed. Every PERIOD seconds it reads, for the processes named
# limactl, every TCP socket in LISTEN and every UDP socket that is not
# connected (lsof), and the free space of WORK's volume (df). It stops and
# deletes INSTANCE at once, records why in WORK/watch-tripped and exits when:
#   - a limactl socket is on a port below 5000 or on an address other than
#     127.0.0.1;
#   - free space is below ABORT_FREE_GIB;
#   - a probe fails: lsof or df errors or prints nothing it can read (on a
#     host with no listening TCP socket at all, lsof prints nothing and the
#     watch trips: it cannot tell that apart from a failure).
# After each pass it writes the time to WORK/watch-heartbeat; run.sh stops the
# run when the heartbeat is older than three periods or the watch is gone.
# It cannot see a socket that opens and closes between two passes, nor one
# held by a process other than limactl.
# ============================================================================
set -uo pipefail

work="${1:?work directory}"
limactl="${2:?limactl}"
instance="${3:?instance}"
period="${4:?period}"
abort_gib="${5:?abort floor}"

trip() {
  printf '%s %s; stopping and deleting %s\n' "$(date -u +%H:%M:%S)" "$*" "$instance" | tee "$work/watch-tripped"
  "$limactl" stop --force "$instance" || true
  "$limactl" delete --force "$instance" || true
  exit 3
}

# The limactl sockets that break the rule, one per line.
violations() {
  local tcp udp
  tcp="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null)" || [ -n "$tcp" ] || return 2
  [ "$(printf '%s\n' "$tcp" | awk 'NR == 1 { print $1 }')" = COMMAND ] || return 2
  udp="$(lsof -nP -iUDP 2>/dev/null)" || [ -n "$udp" ] || return 2
  [ "$(printf '%s\n' "$udp" | awk 'NR == 1 { print $1 }')" = COMMAND ] || return 2
  {
    printf '%s\n' "$tcp" | awk '$1 == "limactl" { print "TCP", $9 }'
    printf '%s\n' "$udp" | awk '$1 == "limactl" && $9 !~ /->/ { print "UDP", $9 }'
  } | awk '{
      n = split($2, part, ":"); port = part[n] + 0
      address = substr($2, 1, length($2) - length(part[n]) - 1)
      if (port < 5000 || address != "127.0.0.1") print $1, $2
    }'
}

while :; do
  found="$(violations)" || trip "a probe failed (lsof printed nothing readable)"
  [ -z "$found" ] || trip "limactl is listening where it must not: $(printf '%s' "$found" | tr '\n' ' ')"
  free="$(df -k "$work" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')"
  [[ "$free" =~ ^[0-9]+$ ]] || trip "a probe failed (df printed nothing readable)"
  [ "$free" -ge "$abort_gib" ] || trip "only $free GiB free (the floor is $abort_gib GiB)"
  # A concurrent reader must see either the previous or the next timestamp.
  date +%s >"$work/watch-heartbeat.next" && mv "$work/watch-heartbeat.next" "$work/watch-heartbeat" ||
    trip "could not publish the watchdog heartbeat"
  sleep "$period"
done
