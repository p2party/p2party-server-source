#!/bin/bash
# ============================================================================
# The rehearsal's SSH guard: ssh, scp and sftp for every Ansible command
# ============================================================================
# play-env.sh puts a directory holding this script as `ssh`, `scp` and `sftp`
# first on PATH, so every connection Ansible makes (its ssh plugin finds these
# programs on PATH, and so does any task that runs them on the control
# machine) passes through it, whatever an inventory, a variable, a playbook or
# ansible.cfg asked for. It runs the real program from /usr/bin only when:
#   - every option is on the allowlist below (no jump host, proxy, forward,
#     host name rewrite, other config file or other program);
#   - `-F /dev/null` is given, so no ssh_config file can rewrite the host;
#   - the port is given and is REHEARSAL_GUARD_PORT (the instance's SSH port);
#   - every destination is 127.0.0.1, as user p2party if a user is named.
# Anything else ends with exit 255 (ssh's own failure code) and a line on
# stderr and in REHEARSAL_GUARD_LOG; the real program never runs.
# ============================================================================
set -uo pipefail

tool="$(basename -- "$0")"
port="${REHEARSAL_GUARD_PORT:-}"
real_dir="${REHEARSAL_GUARD_REAL_DIR:-/usr/bin}"
guard_log="${REHEARSAL_GUARD_LOG:-/dev/null}"

refuse() {
  printf 'ssh-guard: refusing %s: %s\n' "$tool" "$*" >&2
  printf '%s refused %s: %s\n' "$(date -u +%H:%M:%S)" "$tool" "$*" >>"$guard_log" 2>/dev/null
  exit 255
}

case "$tool" in
  ssh | scp | sftp) ;;
  *) refuse "this guard runs only as ssh, scp or sftp" ;;
esac
[[ "$port" =~ ^[0-9]+$ ]] || refuse "REHEARSAL_GUARD_PORT is not set"
[ -x "$real_dir/$tool" ] || refuse "no $real_dir/$tool"

# Single-letter flags without an argument, and options with one, per tool.
case "$tool" in
  ssh) flags="CqvtT" options="oFilp" ;;
  scp) flags="Cqv" options="oFiP" ;;
  sftp) flags="Cqv" options="oFiPb" ;;
esac

config_file=""
ports=()
users=()
positionals=()

strip_quotes() {
  local value="$1"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

check_option() {
  local option="$1" key value
  if [[ "$option" == *=* ]]; then
    key="${option%%=*}"
    value="${option#*=}"
  else
    key="${option%% *}"
    value="${option#* }"
  fi
  value="$(strip_quotes "$value")"
  case "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" in
    port) ports+=("$value") ;;
    user) users+=("$value") ;;
    forwardagent) [ "$value" = no ] || refuse "-o $option" ;;
    numberofpasswordprompts) [ "$value" = 1 ] || refuse "-o $option" ;;
    controlmaster | controlpersist | controlpath | identitiesonly | batchmode | identityfile | \
      kbdinteractiveauthentication | preferredauthentications | passwordauthentication | \
      connecttimeout | userknownhostsfile | stricthostkeychecking | loglevel | \
      serveraliveinterval | serveralivecountmax | compression) ;;
    *) refuse "-o $option is not on the guard's allowlist" ;;
  esac
}

args=("$@")
index=0
while [ "$index" -lt "${#args[@]}" ]; do
  arg="${args[$index]}"
  if [ "${#positionals[@]}" -gt 0 ] && [ "$tool" = ssh ]; then
    # After ssh's destination, the rest is the remote command.
    positionals+=("$arg")
  elif [[ "$arg" == -?* && "$arg" != -- ]]; then
    letters="${arg#-}"
    while [ -n "$letters" ]; do
      letter="${letters:0:1}"
      letters="${letters:1}"
      if [[ "$flags" == *"$letter"* ]]; then
        continue
      elif [[ "$options" == *"$letter"* ]]; then
        if [ -n "$letters" ]; then
          value="$letters"
          letters=""
        else
          index=$((index + 1))
          [ "$index" -lt "${#args[@]}" ] || refuse "-$letter needs a value"
          value="${args[$index]}"
        fi
        case "$letter" in
          o) check_option "$value" ;;
          F) config_file="$value" ;;
          p | P) ports+=("$value") ;;
          l) users+=("$value") ;;
          i) ;;
          b) [ "$value" = - ] || refuse "-b $value (only a batch from stdin)" ;;
        esac
      else
        refuse "-$letter is not on the guard's allowlist"
      fi
    done
  elif [ "$arg" = -- ]; then
    index=$((index + 1))
    while [ "$index" -lt "${#args[@]}" ]; do
      positionals+=("${args[$index]}")
      index=$((index + 1))
    done
    break
  else
    positionals+=("$arg")
  fi
  index=$((index + 1))
done

[ "$config_file" = /dev/null ] || refuse "no -F /dev/null (an ssh_config file could rewrite the host)"
[ "${#ports[@]}" -ge 1 ] || refuse "no port given (the default would be 22)"
for given in "${ports[@]}"; do
  [ "$given" = "$port" ] || refuse "port $given, not the instance's $port"
done

# A destination: [user@]host, with the host bracketed or not.
check_destination() {
  local destination="$1" host
  host="$destination"
  if [[ "$host" == *@* ]]; then
    users+=("${host%@*}")
    host="${host##*@}"
  fi
  host="${host#[}"
  host="${host%]}"
  [ "$host" = 127.0.0.1 ] || refuse "destination $destination, not 127.0.0.1"
}

case "$tool" in
  ssh)
    [ "${#positionals[@]}" -ge 1 ] || refuse "no destination"
    [[ "${positionals[0]}" != ssh://* ]] || refuse "a URI destination"
    check_destination "${positionals[0]}"
    ;;
  sftp)
    [ "${#positionals[@]}" -eq 1 ] || refuse "not exactly one destination"
    destination="${positionals[0]}"
    [[ "$destination" != sftp://* ]] || refuse "a URI destination"
    if [[ "$destination" =~ ^(\[[^]]*\]|[^:]*):.*$ ]]; then destination="${BASH_REMATCH[1]}"; fi
    check_destination "$destination"
    ;;
  scp)
    remote=0
    for spec in "${positionals[@]}"; do
      [[ "$spec" != scp://* ]] || refuse "a URI destination"
      if [[ "$spec" =~ ^((\[[^]]*\])|([^/:[]+)):(.*)$ ]]; then
        check_destination "${BASH_REMATCH[1]}"
        remote=$((remote + 1))
      fi
    done
    [ "$remote" -ge 1 ] || refuse "no remote path"
    ;;
esac
for user in "${users[@]+"${users[@]}"}"; do
  [ "$(strip_quotes "$user")" = p2party ] || refuse "user $user, not p2party"
done

printf '%s allowed %s 127.0.0.1:%s\n' "$(date -u +%H:%M:%S)" "$tool" "$port" >>"$guard_log" 2>/dev/null
exec "$real_dir/$tool" "$@"
