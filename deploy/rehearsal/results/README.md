# Rehearsal results

The files of 2026-11-26 were written by `run.sh` as of `fa167a1` and earlier:
their "Commit under test" line is the commit deployed (the baseline file names
one too, though that run installs release 0.1.4 only), and their "Harness"
line names the repository's HEAD at the time, not the harness that ran, which
was an archive of HEAD plus uncommitted changes for some of them; they do not
show which `run.sh` produced them. Later files name the commit under test, the
baseline commit and the harness separately (`run.sh`'s and `lima.yaml`'s
SHA-256, and the commit when the harness equals it).
