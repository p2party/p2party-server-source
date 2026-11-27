#!/usr/bin/python3
"""APT protocol-1 pre-install hook. Allow only archives from this host's reviewed transaction."""

import pathlib
import re
import subprocess
import sys


receipt = pathlib.Path(__file__).resolve().parent
native_arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
allowed = set()
for line in (receipt / "packages.plan").read_text().splitlines():
    match = re.match(r"^Inst (\S+)(?: \[[^]]*\])? \((\S+)", line)
    if not match:
        sys.exit("Unrecognized package transaction entry")
    package, version = match.groups()
    name, _, arch = package.partition(":")
    for permitted_arch in ([arch] if arch else [native_arch, "all"]):
        allowed.add((name, version, permitted_arch))

for line in sys.stdin:
    archive = line.rstrip("\n")
    fields = subprocess.check_output(
        ["dpkg-deb", "--show", "--showformat=${Package}\\t${Version}\\t${Architecture}", archive],
        text=True,
    ).split("\t")
    if tuple(fields) not in allowed:
        sys.exit("APT selected an unreviewed package or version: " + " ".join(fields))
