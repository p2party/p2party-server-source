"""Check the actual Linux executable backing the systemd worker for this port."""
import hashlib
import subprocess
import sys
from pathlib import Path


def main_pid(unit):
    value = subprocess.check_output(
        ["/usr/bin/systemctl", "show", "--property=MainPID", "--value", unit],
        text=True,
    ).strip()
    if not value.isdecimal() or int(value) <= 1:
        raise SystemExit(f"{unit} has no running worker")
    return value


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def running_checksum(process, mode):
    executable = process / "exe"
    if mode != "rosetta" or executable.readlink() != Path("/mnt/lima-rosetta/rosetta"):
        return checksum(executable)

    # Lima runs the x86-64 release via Rosetta on Apple Silicon. Read the
    # kernel's handle to the executable mapping, including when its on-disk
    # pathname was replaced after exec. Production uses /proc/PID/exe.
    for line in (process / "maps").read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) != 6 or "x" not in fields[1]:
            continue
        if Path(fields[5].removesuffix(" (deleted)")).name != "p2party-server":
            continue
        start, end = [int(address, 16) for address in fields[0].split("-")]
        return checksum(process / "map_files" / f"{start:x}-{end:x}")
    raise SystemExit("Rosetta has no executable mapping for the signaling binary")


port, expected, mode = sys.argv[1:]
unit = f"p2party-signaling-{int(port)}.service"
pid = main_pid(unit)
actual = running_checksum(Path("/proc") / pid, mode)
if actual != expected or main_pid(unit) != pid:
    raise SystemExit(f"{unit} did not keep running the expected executable (SHA-256 {actual})")
