#!/usr/bin/env python3
"""Check both native signature suites against fixed public test vectors."""
import base64
import json
import subprocess
import sys
from pathlib import Path


def main():
    binary, vectors = sys.argv[1:]
    cases = json.loads(Path(vectors).read_text())
    if len(cases) != 2:
        raise ValueError("expected both native signature suites")
    for case, size in zip(cases, (5505, 16516)):
        request = base64.b64decode(case["request"], validate=True)
        reply = base64.b64decode(case["reply"], validate=True)
        if len(request) != 183 + size or len(reply) != 193:
            raise ValueError("invalid native vector lengths")
        good = subprocess.run([binary], input=request, capture_output=True, timeout=3)
        if good.returncode or good.stdout != reply:
            raise ValueError("native verifier failed a signed test vector")
        bad = subprocess.run([binary], input=request[:-1] + bytes([request[-1] ^ 1]),
                             capture_output=True, timeout=3)
        if bad.returncode != 1 or bad.stdout:
            raise ValueError("native verifier accepted a modified signature")
    print("Both native signature suites passed positive and negative test vectors.")


if __name__ == "__main__":
    main()
