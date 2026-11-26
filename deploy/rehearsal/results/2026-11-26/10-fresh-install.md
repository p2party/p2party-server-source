# Fresh install: the commit's site.yml on a new VM, then deploy.yml and initial-setup.yml

- Commit under test: `f6802bd7f7f49a1639f3667935f0cb13c6a4f1b3` (Tell a room's members when a member leaves or its last socket closes)
- Release before it: `ecf691a957b2` (0.1.4, `master`)
- Harness: `deploy/rehearsal/run.sh fresh` from the tree at `f6802bd7f7f4`
- Started: 2026-11-26T23:45:05Z

cloud-init schema --config-file (the rendered signaling template):

```text
Valid schema /tmp/signaling_cloud_init.yaml
```

Stand-in `lima-ssh-firewall` (exit 0):

```text
Rules updated
```

- `package_update_upgrade_install` ran apt's update, dist-upgrade and the template's package installs, then failed at its snap refresh: the rehearsal masks snapd (lima.yaml), so cloud-init's snap step is the one part of the template not reproduced.

cloud-init single, modules users_groups, package_update_upgrade_install, write_files, runcmd, scripts_user:

```text
Cloud-init v. 26.1-0ubuntu1~24.04.1 running 'single' at Thu, 26 Nov 2026 23:45:22 +0000. Up 14.01 seconds.
Cloud-init v. 26.1-0ubuntu1~24.04.1 running 'single' at Thu, 26 Nov 2026 23:45:22 +0000. Up 14.30 seconds.
Hit:1 http://ports.ubuntu.com/ubuntu-ports noble InRelease
Get:2 http://ports.ubuntu.com/ubuntu-ports noble-updates InRelease [126 kB]
Get:3 http://ports.ubuntu.com/ubuntu-ports noble-backports InRelease [126 kB]
Get:4 http://ports.ubuntu.com/ubuntu-ports noble-security InRelease [126 kB]
Get:5 http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages [15.3 MB]
Get:6 http://ports.ubuntu.com/ubuntu-ports noble/universe Translation-en [5982 kB]
Get:7 http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Components [3573 kB]
Get:8 http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 c-n-f Metadata [295 kB]
Get:9 http://ports.ubuntu.com/ubuntu-ports noble/multiverse arm64 Packages [223 kB]
Get:10 http://ports.ubuntu.com/ubuntu-ports noble/multiverse Translation-en [118 kB]
Get:11 http://ports.ubuntu.com/ubuntu-ports noble/multiverse arm64 Components [31.6 kB]
Get:12 http://ports.ubuntu.com/ubuntu-ports noble/multiverse arm64 c-n-f Metadata [7152 B]
Get:13 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 Packages [1554 kB]
Get:14 http://ports.ubuntu.com/ubuntu-ports noble-updates/main Translation-en [321 kB]
Get:15 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 Components [178 kB]
Get:16 http://ports.ubuntu.com/ubuntu-ports noble-updates/universe arm64 Packages [1774 kB]
Get:17 http://ports.ubuntu.com/ubuntu-ports noble-updates/universe Translation-en [346 kB]
Get:18 http://ports.ubuntu.com/ubuntu-ports noble-updates/universe arm64 Components [387 kB]
Get:19 http://ports.ubuntu.com/ubuntu-ports noble-updates/universe arm64 c-n-f Metadata [33.5 kB]
Get:20 http://ports.ubuntu.com/ubuntu-ports noble-updates/restricted arm64 Packages [2909 kB]
Get:21 http://ports.ubuntu.com/ubuntu-ports noble-updates/restricted Translation-en [448 kB]
Get:22 http://ports.ubuntu.com/ubuntu-ports noble-updates/multiverse arm64 Packages [91.1 kB]
Get:23 http://ports.ubuntu.com/ubuntu-ports noble-updates/multiverse Translation-en [14.6 kB]
Get:24 http://ports.ubuntu.com/ubuntu-ports noble-updates/multiverse arm64 Components [212 B]
Get:25 http://ports.ubuntu.com/ubuntu-ports noble-updates/multiverse arm64 c-n-f Metadata [472 B]
Get:26 http://ports.ubuntu.com/ubuntu-ports noble-backports/main arm64 Packages [40.7 kB]
Get:27 http://ports.ubuntu.com/ubuntu-ports noble-backports/main Translation-en [9172 B]
Get:28 http://ports.ubuntu.com/ubuntu-ports noble-backports/main arm64 Components [3568 B]
Get:29 http://ports.ubuntu.com/ubuntu-ports noble-backports/main arm64 c-n-f Metadata [372 B]
Get:30 http://ports.ubuntu.com/ubuntu-ports noble-backports/universe arm64 Packages [31.3 kB]
Get:31 http://ports.ubuntu.com/ubuntu-ports noble-backports/universe Translation-en [18.6 kB]
Get:32 http://ports.ubuntu.com/ubuntu-ports noble-backports/universe arm64 Components [12.6 kB]
Get:33 http://ports.ubuntu.com/ubuntu-ports noble-backports/universe arm64 c-n-f Metadata [1592 B]
Get:34 http://ports.ubuntu.com/ubuntu-ports noble-backports/restricted arm64 Components [212 B]
Get:35 http://ports.ubuntu.com/ubuntu-ports noble-backports/restricted arm64 c-n-f Metadata [116 B]
Get:36 http://ports.ubuntu.com/ubuntu-ports noble-backports/multiverse arm64 Packages [748 B]
Get:37 http://ports.ubuntu.com/ubuntu-ports noble-backports/multiverse Translation-en [340 B]
Get:38 http://ports.ubuntu.com/ubuntu-ports noble-backports/multiverse arm64 Components [212 B]
Get:39 http://ports.ubuntu.com/ubuntu-ports noble-backports/multiverse arm64 c-n-f Metadata [116 B]
Get:40 http://ports.ubuntu.com/ubuntu-ports noble-security/main arm64 Packages [1305 kB]
Get:41 http://ports.ubuntu.com/ubuntu-ports noble-security/main Translation-en [243 kB]
Get:42 http://ports.ubuntu.com/ubuntu-ports noble-security/main arm64 Components [43.3 kB]
Get:43 http://ports.ubuntu.com/ubuntu-ports noble-security/universe arm64 Packages [1324 kB]
Get:44 http://ports.ubuntu.com/ubuntu-ports noble-security/universe Translation-en [249 kB]
Get:45 http://ports.ubuntu.com/ubuntu-ports noble-security/universe arm64 Components [76.2 kB]
Get:46 http://ports.ubuntu.com/ubuntu-ports noble-security/universe arm64 c-n-f Metadata [23.7 kB]
Get:47 http://ports.ubuntu.com/ubuntu-ports noble-security/restricted arm64 Packages [2801 kB]
Get:48 http://ports.ubuntu.com/ubuntu-ports noble-security/restricted Translation-en [429 kB]
Get:49 http://ports.ubuntu.com/ubuntu-ports noble-security/multiverse arm64 Packages [87.1 kB]
Get:50 http://ports.ubuntu.com/ubuntu-ports noble-security/multiverse Translation-en [12.7 kB]
Get:51 http://ports.ubuntu.com/ubuntu-ports noble-security/multiverse arm64 Components [208 B]
Get:52 http://ports.ubuntu.com/ubuntu-ports noble-security/multiverse arm64 c-n-f Metadata [456 B]
Fetched 40.7 MB in 5s (8326 kB/s)
Reading package lists...
Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following NEW packages will be installed:
  linux-headers-6.8.0-151 linux-headers-6.8.0-151-generic
  linux-image-6.8.0-151-generic linux-modules-6.8.0-151-generic
  linux-tools-6.8.0-151 linux-tools-6.8.0-151-generic
The following upgrades have been deferred due to phasing:
  libsqlite3-0
The following packages will be upgraded:
  apt apt-utils bind9-dnsutils bind9-host bind9-libs ca-certificates
  cloud-init distro-info distro-info-data gir1.2-glib-2.0 git git-man
  krb5-locales libapt-pkg6.0t64 libbrotli1 libc-bin libc-dev-bin libc-devtools
  libc6 libc6-dev libdw1t64 libelf1t64 libexpat1 libglib2.0-0t64
  libglib2.0-bin libglib2.0-data libgssapi-krb5-2 libgstreamer1.0-0
  libheif-plugin-aomdec libheif-plugin-aomenc libheif1 libk5crypto3 libkrb5-3
  libkrb5support0 liblzma5 libmspack0t64 libnss-systemd libnss3 libpam-systemd
  libpcap0.8t64 libpcre2-8-0 libperl5.38t64 libssh-4 libsystemd-shared
  libsystemd0 libtiff6 libudev1 linux-headers-generic linux-headers-virtual
  linux-image-virtual linux-libc-dev linux-tools-common linux-virtual locales
  needrestart perl perl-base perl-modules-5.38 python3-distro-info python3-jwt
  python3-oauthlib python3-pyasn1 python3-twisted snapd sosreport systemd
  systemd-dev systemd-resolved systemd-sysv systemd-timesyncd tmux tzdata
  ubuntu-pro-client ubuntu-pro-client-l10n udev xz-utils zlib1g
77 upgraded, 6 newly installed, 0 to remove and 1 not upgraded.
Need to get 198 MB of archives.
After this operation, 196 MB of additional disk space will be used.
Get:1 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libperl5.38t64 arm64 5.38.2-3.2ubuntu0.7 [4777 kB]
Get:2 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 perl arm64 5.38.2-3.2ubuntu0.7 [231 kB]
Get:3 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 perl-base arm64 5.38.2-3.2ubuntu0.7 [1780 kB]
Get:4 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 perl-modules-5.38 all 5.38.2-3.2ubuntu0.7 [3110 kB]
Get:5 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libc-devtools arm64 2.39-0ubuntu8.12 [27.8 kB]
Get:6 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libc6-dev arm64 2.39-0ubuntu8.12 [1596 kB]
Get:7 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libc-dev-bin arm64 2.39-0ubuntu8.12 [19.7 kB]
Get:8 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-libc-dev arm64 6.8.0-151.151 [1686 kB]
Get:9 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libc6 arm64 2.39-0ubuntu8.12 [2774 kB]
Get:10 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 zlib1g arm64 1:1.3.dfsg-3.1ubuntu2.3 [62.1 kB]
Get:11 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libc-bin arm64 2.39-0ubuntu8.12 [591 kB]
Get:12 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 liblzma5 arm64 5.6.1+really5.4.5-1ubuntu0.4 [126 kB]
Get:13 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 systemd-timesyncd arm64 255.4-1ubuntu8.19 [34.8 kB]
Get:14 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 systemd-resolved arm64 255.4-1ubuntu8.19 [291 kB]
Get:15 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libnss-systemd arm64 255.4-1ubuntu8.19 [155 kB]
Get:16 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 systemd-dev all 255.4-1ubuntu8.19 [108 kB]
Get:17 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 systemd arm64 255.4-1ubuntu8.19 [3408 kB]
Get:18 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 udev arm64 255.4-1ubuntu8.19 [1853 kB]
Get:19 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 systemd-sysv arm64 255.4-1ubuntu8.19 [11.9 kB]
Get:20 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libpam-systemd arm64 255.4-1ubuntu8.19 [232 kB]
Get:21 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libsystemd-shared arm64 255.4-1ubuntu8.19 [2022 kB]
Get:22 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libudev1 arm64 255.4-1ubuntu8.19 [177 kB]
Get:23 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libsystemd0 arm64 255.4-1ubuntu8.19 [428 kB]
Get:24 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libapt-pkg6.0t64 arm64 2.8.4ubuntu0.1 [937 kB]
Get:25 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 apt arm64 2.8.4ubuntu0.1 [1357 kB]
Get:26 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 apt-utils arm64 2.8.4ubuntu0.1 [304 kB]
Get:27 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libpcre2-8-0 arm64 10.42-4ubuntu2.2 [213 kB]
Get:28 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 ca-certificates all 20260816ubuntu0.24.04.2 [140 kB]
Get:29 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 distro-info-data all 2026.10.12-0ubuntu0.24.04.1 [7836 B]
Get:30 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 distro-info arm64 1.7ubuntu0.1 [19.4 kB]
Get:31 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libglib2.0-data all 2.80.0-6ubuntu3.10 [50.2 kB]
Get:32 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libdw1t64 arm64 0.190-1.1ubuntu0.2 [258 kB]
Get:33 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libelf1t64 arm64 0.190-1.1ubuntu0.2 [58.6 kB]
Get:34 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libglib2.0-bin arm64 2.80.0-6ubuntu3.10 [97.1 kB]
Get:35 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 gir1.2-glib-2.0 arm64 2.80.0-6ubuntu3.10 [182 kB]
Get:36 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libglib2.0-0t64 arm64 2.80.0-6ubuntu3.10 [1533 kB]
Get:37 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 krb5-locales all 1.20.1-6ubuntu2.12 [16.5 kB]
Get:38 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libexpat1 arm64 2.6.1-2ubuntu0.7 [93.9 kB]
Get:39 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libgssapi-krb5-2 arm64 1.20.1-6ubuntu2.12 [142 kB]
Get:40 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libkrb5-3 arm64 1.20.1-6ubuntu2.12 [350 kB]
Get:41 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libkrb5support0 arm64 1.20.1-6ubuntu2.12 [36.5 kB]
Get:42 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libk5crypto3 arm64 1.20.1-6ubuntu2.12 [85.8 kB]
Get:43 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 locales all 2.39-0ubuntu8.12 [4232 kB]
Get:44 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 tzdata all 2026f-0ubuntu0.24.04.1 [283 kB]
Get:45 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 ubuntu-pro-client-l10n arm64 38ubuntu0~24.04 [19.8 kB]
Get:46 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 ubuntu-pro-client arm64 38ubuntu0~24.04 [259 kB]
Get:47 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 bind9-dnsutils arm64 1:9.18.39-0ubuntu0.24.04.9 [156 kB]
Get:48 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 bind9-host arm64 1:9.18.39-0ubuntu0.24.04.9 [50.1 kB]
Get:49 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 bind9-libs arm64 1:9.18.39-0ubuntu0.24.04.9 [1224 kB]
Get:50 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libpcap0.8t64 arm64 1.10.4-4.1ubuntu3.2 [151 kB]
Get:51 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 python3-distro-info all 1.7ubuntu0.1 [7374 B]
Get:52 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 xz-utils arm64 5.6.1+really5.4.5-1ubuntu0.4 [268 kB]
Get:53 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 git-man all 1:2.43.0-1ubuntu7.4 [1101 kB]
Get:54 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 git arm64 1:2.43.0-1ubuntu7.4 [3774 kB]
Get:55 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libbrotli1 arm64 1.1.0-2ubuntu0.1 [340 kB]
Get:56 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libgstreamer1.0-0 arm64 1.24.2-1ubuntu0.2 [1149 kB]
Get:57 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libheif-plugin-aomenc arm64 1.17.6-1ubuntu4.10 [13.7 kB]
Get:58 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libheif-plugin-aomdec arm64 1.17.6-1ubuntu4.10 [11.8 kB]
Get:59 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libheif1 arm64 1.17.6-1ubuntu4.10 [263 kB]
Get:60 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libmspack0t64 arm64 0.11-1.1ubuntu0.24.04.1 [38.4 kB]
Get:61 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libnss3 arm64 2:3.98-1ubuntu0.3 [1407 kB]
Get:62 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libssh-4 arm64 0.10.6-2ubuntu0.6 [193 kB]
Get:63 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libtiff6 arm64 4.5.1+git230720-4ubuntu2.6 [192 kB]
Get:64 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-headers-6.8.0-151 all 6.8.0-151.151 [13.8 MB]
Get:65 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-headers-6.8.0-151-generic arm64 6.8.0-151.151 [3330 kB]
Get:66 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-modules-6.8.0-151-generic arm64 6.8.0-151.151 [87.3 MB]
Get:67 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-image-6.8.0-151-generic arm64 6.8.0-151.151 [18.4 MB]
Get:68 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-virtual arm64 6.8.0-151.151 [1700 B]
Get:69 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-image-virtual arm64 6.8.0-151.151 [11.6 kB]
Get:70 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-headers-virtual arm64 6.8.0-151.151 [1646 B]
Get:71 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-headers-generic arm64 6.8.0-151.151 [11.5 kB]
Get:72 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-tools-common all 6.8.0-151.151 [552 kB]
Get:73 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-tools-6.8.0-151 arm64 6.8.0-151.151 [3939 kB]
Get:74 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 linux-tools-6.8.0-151-generic arm64 6.8.0-151.151 [1744 B]
Get:75 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 needrestart all 3.6-7ubuntu4.6 [49.2 kB]
Get:76 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 python3-jwt all 2.7.0-1ubuntu0.6 [23.8 kB]
Get:77 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 python3-oauthlib all 3.2.2-1ubuntu0.1 [90.0 kB]
Get:78 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 python3-pyasn1 all 0.4.8-4ubuntu0.4 [52.9 kB]
Get:79 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 python3-twisted all 24.3.0-1ubuntu0.3 [2063 kB]
Get:80 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 snapd arm64 2.78+ubuntu24.04 [20.6 MB]
Get:81 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 sosreport arm64 4.11.2-0ubuntu0~24.04.2 [408 kB]
Get:82 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 tmux arm64 3.4-1ubuntu0.2 [465 kB]
Get:83 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 cloud-init all 26.2-0ubuntu1~24.04.2 [634 kB]
Preconfiguring packages ...
Fetched 198 MB in 7s (28.5 MB/s)
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../libperl5.38t64_5.38.2-3.2ubuntu0.7_arm64.deb ...
Unpacking libperl5.38t64:arm64 (5.38.2-3.2ubuntu0.7) over (5.38.2-3.2ubuntu0.6) ...
Preparing to unpack .../perl_5.38.2-3.2ubuntu0.7_arm64.deb ...
Unpacking perl (5.38.2-3.2ubuntu0.7) over (5.38.2-3.2ubuntu0.6) ...
Preparing to unpack .../perl-base_5.38.2-3.2ubuntu0.7_arm64.deb ...
Unpacking perl-base (5.38.2-3.2ubuntu0.7) over (5.38.2-3.2ubuntu0.6) ...
Setting up perl-base (5.38.2-3.2ubuntu0.7) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../0-perl-modules-5.38_5.38.2-3.2ubuntu0.7_all.deb ...
Unpacking perl-modules-5.38 (5.38.2-3.2ubuntu0.7) over (5.38.2-3.2ubuntu0.6) ...
Preparing to unpack .../1-libc-devtools_2.39-0ubuntu8.12_arm64.deb ...
Unpacking libc-devtools (2.39-0ubuntu8.12) over (2.39-0ubuntu8.9) ...
Preparing to unpack .../2-libc6-dev_2.39-0ubuntu8.12_arm64.deb ...
Unpacking libc6-dev:arm64 (2.39-0ubuntu8.12) over (2.39-0ubuntu8.9) ...
Preparing to unpack .../3-libc-dev-bin_2.39-0ubuntu8.12_arm64.deb ...
Unpacking libc-dev-bin (2.39-0ubuntu8.12) over (2.39-0ubuntu8.9) ...
Preparing to unpack .../4-linux-libc-dev_6.8.0-151.151_arm64.deb ...
Unpacking linux-libc-dev:arm64 (6.8.0-151.151) over (6.8.0-147.147) ...
Preparing to unpack .../5-libc6_2.39-0ubuntu8.12_arm64.deb ...
Unpacking libc6:arm64 (2.39-0ubuntu8.12) over (2.39-0ubuntu8.9) ...
Setting up libc6:arm64 (2.39-0ubuntu8.12) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../zlib1g_1%3a1.3.dfsg-3.1ubuntu2.3_arm64.deb ...
Unpacking zlib1g:arm64 (1:1.3.dfsg-3.1ubuntu2.3) over (1:1.3.dfsg-3.1ubuntu2.2) ...
Setting up zlib1g:arm64 (1:1.3.dfsg-3.1ubuntu2.3) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../libc-bin_2.39-0ubuntu8.12_arm64.deb ...
Unpacking libc-bin (2.39-0ubuntu8.12) over (2.39-0ubuntu8.9) ...
Setting up libc-bin (2.39-0ubuntu8.12) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../liblzma5_5.6.1+really5.4.5-1ubuntu0.4_arm64.deb ...
Unpacking liblzma5:arm64 (5.6.1+really5.4.5-1ubuntu0.4) over (5.6.1+really5.4.5-1ubuntu0.3) ...
Setting up liblzma5:arm64 (5.6.1+really5.4.5-1ubuntu0.4) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../0-systemd-timesyncd_255.4-1ubuntu8.19_arm64.deb ...
Unpacking systemd-timesyncd (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../1-systemd-resolved_255.4-1ubuntu8.19_arm64.deb ...
Unpacking systemd-resolved (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../2-libnss-systemd_255.4-1ubuntu8.19_arm64.deb ...
Unpacking libnss-systemd:arm64 (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../3-systemd-dev_255.4-1ubuntu8.19_all.deb ...
Unpacking systemd-dev (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../4-systemd_255.4-1ubuntu8.19_arm64.deb ...
Unpacking systemd (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../5-udev_255.4-1ubuntu8.19_arm64.deb ...
Unpacking udev (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../6-libsystemd-shared_255.4-1ubuntu8.19_arm64.deb ...
Unpacking libsystemd-shared:arm64 (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Setting up libsystemd-shared:arm64 (255.4-1ubuntu8.19) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../libsystemd0_255.4-1ubuntu8.19_arm64.deb ...
Unpacking libsystemd0:arm64 (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Setting up libsystemd0:arm64 (255.4-1ubuntu8.19) ...
Setting up systemd-dev (255.4-1ubuntu8.19) ...
Setting up systemd (255.4-1ubuntu8.19) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../systemd-sysv_255.4-1ubuntu8.19_arm64.deb ...
Unpacking systemd-sysv (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../libpam-systemd_255.4-1ubuntu8.19_arm64.deb ...
Unpacking libpam-systemd:arm64 (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Preparing to unpack .../libudev1_255.4-1ubuntu8.19_arm64.deb ...
Unpacking libudev1:arm64 (255.4-1ubuntu8.19) over (255.4-1ubuntu8.18) ...
Setting up libudev1:arm64 (255.4-1ubuntu8.19) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../libapt-pkg6.0t64_2.8.4ubuntu0.1_arm64.deb ...
Unpacking libapt-pkg6.0t64:arm64 (2.8.4ubuntu0.1) over (2.8.3) ...
Setting up libapt-pkg6.0t64:arm64 (2.8.4ubuntu0.1) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../apt_2.8.4ubuntu0.1_arm64.deb ...
Unpacking apt (2.8.4ubuntu0.1) over (2.8.3) ...
Setting up apt (2.8.4ubuntu0.1) ...
apt-daily-upgrade.timer is a disabled or a static unit not running, not starting it.
apt-daily.timer is a disabled or a static unit not running, not starting it.
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77748 files and directories currently installed.)
Preparing to unpack .../apt-utils_2.8.4ubuntu0.1_arm64.deb ...
Unpacking apt-utils (2.8.4ubuntu0.1) over (2.8.3) ...
Preparing to unpack .../libpcre2-8-0_10.42-4ubuntu2.2_arm64.deb ...
Unpacking libpcre2-8-0:arm64 (10.42-4ubuntu2.2) over (10.42-4ubuntu2.1) ...
Setting up libpcre2-8-0:arm64 (10.42-4ubuntu2.2) ...
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 77791 files and directories currently installed.)
Preparing to unpack .../00-ca-certificates_20260816ubuntu0.24.04.2_all.deb ...
Unpacking ca-certificates (20260816ubuntu0.24.04.2) over (20260601~24.04.1) ...
Preparing to unpack .../01-distro-info-data_2026.10.12-0ubuntu0.24.04.1_all.deb ...
Unpacking distro-info-data (2026.10.12-0ubuntu0.24.04.1) over (0.72-0ubuntu0.24.04.1) ...
Preparing to unpack .../02-distro-info_1.7ubuntu0.1_arm64.deb ...
Unpacking distro-info (1.7ubuntu0.1) over (1.7build1) ...
Preparing to unpack .../03-libglib2.0-data_2.80.0-6ubuntu3.10_all.deb ...
Unpacking libglib2.0-data (2.80.0-6ubuntu3.10) over (2.80.0-6ubuntu3.9) ...
Preparing to unpack .../04-libdw1t64_0.190-1.1ubuntu0.2_arm64.deb ...
Unpacking libdw1t64:arm64 (0.190-1.1ubuntu0.2) over (0.190-1.1ubuntu0.1) ...
Preparing to unpack .../05-libelf1t64_0.190-1.1ubuntu0.2_arm64.deb ...
Unpacking libelf1t64:arm64 (0.190-1.1ubuntu0.2) over (0.190-1.1ubuntu0.1) ...
Preparing to unpack .../06-libglib2.0-bin_2.80.0-6ubuntu3.10_arm64.deb ...
Unpacking libglib2.0-bin (2.80.0-6ubuntu3.10) over (2.80.0-6ubuntu3.9) ...
Preparing to unpack .../07-gir1.2-glib-2.0_2.80.0-6ubuntu3.10_arm64.deb ...
Unpacking gir1.2-glib-2.0:arm64 (2.80.0-6ubuntu3.10) over (2.80.0-6ubuntu3.9) ...
Preparing to unpack .../08-libglib2.0-0t64_2.80.0-6ubuntu3.10_arm64.deb ...
Unpacking libglib2.0-0t64:arm64 (2.80.0-6ubuntu3.10) over (2.80.0-6ubuntu3.9) ...
Preparing to unpack .../09-krb5-locales_1.20.1-6ubuntu2.12_all.deb ...
Unpacking krb5-locales (1.20.1-6ubuntu2.12) over (1.20.1-6ubuntu2.10) ...
Preparing to unpack .../10-libexpat1_2.6.1-2ubuntu0.7_arm64.deb ...
Unpacking libexpat1:arm64 (2.6.1-2ubuntu0.7) over (2.6.1-2ubuntu0.6) ...
Preparing to unpack .../11-libgssapi-krb5-2_1.20.1-6ubuntu2.12_arm64.deb ...
Unpacking libgssapi-krb5-2:arm64 (1.20.1-6ubuntu2.12) over (1.20.1-6ubuntu2.10) ...
Preparing to unpack .../12-libkrb5-3_1.20.1-6ubuntu2.12_arm64.deb ...
Unpacking libkrb5-3:arm64 (1.20.1-6ubuntu2.12) over (1.20.1-6ubuntu2.10) ...
Preparing to unpack .../13-libkrb5support0_1.20.1-6ubuntu2.12_arm64.deb ...
Unpacking libkrb5support0:arm64 (1.20.1-6ubuntu2.12) over (1.20.1-6ubuntu2.10) ...
Preparing to unpack .../14-libk5crypto3_1.20.1-6ubuntu2.12_arm64.deb ...
Unpacking libk5crypto3:arm64 (1.20.1-6ubuntu2.12) over (1.20.1-6ubuntu2.10) ...
Preparing to unpack .../15-locales_2.39-0ubuntu8.12_all.deb ...
Unpacking locales (2.39-0ubuntu8.12) over (2.39-0ubuntu8.9) ...
Preparing to unpack .../16-tzdata_2026f-0ubuntu0.24.04.1_all.deb ...
Unpacking tzdata (2026f-0ubuntu0.24.04.1) over (2026e-0ubuntu0.24.04.1) ...
Preparing to unpack .../17-ubuntu-pro-client-l10n_38ubuntu0~24.04_arm64.deb ...
Unpacking ubuntu-pro-client-l10n (38ubuntu0~24.04) over (37.2ubuntu~24.04.1) ...
Preparing to unpack .../18-ubuntu-pro-client_38ubuntu0~24.04_arm64.deb ...
Unpacking ubuntu-pro-client (38ubuntu0~24.04) over (37.2ubuntu~24.04.1) ...
Preparing to unpack .../19-bind9-dnsutils_1%3a9.18.39-0ubuntu0.24.04.9_arm64.deb ...
Unpacking bind9-dnsutils (1:9.18.39-0ubuntu0.24.04.9) over (1:9.18.39-0ubuntu0.24.04.8) ...
Preparing to unpack .../20-bind9-host_1%3a9.18.39-0ubuntu0.24.04.9_arm64.deb ...
Unpacking bind9-host (1:9.18.39-0ubuntu0.24.04.9) over (1:9.18.39-0ubuntu0.24.04.8) ...
Preparing to unpack .../21-bind9-libs_1%3a9.18.39-0ubuntu0.24.04.9_arm64.deb ...
Unpacking bind9-libs:arm64 (1:9.18.39-0ubuntu0.24.04.9) over (1:9.18.39-0ubuntu0.24.04.8) ...
Preparing to unpack .../22-libpcap0.8t64_1.10.4-4.1ubuntu3.2_arm64.deb ...
Unpacking libpcap0.8t64:arm64 (1.10.4-4.1ubuntu3.2) over (1.10.4-4.1ubuntu3.1) ...
Preparing to unpack .../23-python3-distro-info_1.7ubuntu0.1_all.deb ...
Unpacking python3-distro-info (1.7ubuntu0.1) over (1.7build1) ...
Preparing to unpack .../24-xz-utils_5.6.1+really5.4.5-1ubuntu0.4_arm64.deb ...
Unpacking xz-utils (5.6.1+really5.4.5-1ubuntu0.4) over (5.6.1+really5.4.5-1ubuntu0.3) ...
Preparing to unpack .../25-git-man_1%3a2.43.0-1ubuntu7.4_all.deb ...
Unpacking git-man (1:2.43.0-1ubuntu7.4) over (1:2.43.0-1ubuntu7.3) ...
Preparing to unpack .../26-git_1%3a2.43.0-1ubuntu7.4_arm64.deb ...
Unpacking git (1:2.43.0-1ubuntu7.4) over (1:2.43.0-1ubuntu7.3) ...
Preparing to unpack .../27-libbrotli1_1.1.0-2ubuntu0.1_arm64.deb ...
Unpacking libbrotli1:arm64 (1.1.0-2ubuntu0.1) over (1.1.0-2build2) ...
Preparing to unpack .../28-libgstreamer1.0-0_1.24.2-1ubuntu0.2_arm64.deb ...
Unpacking libgstreamer1.0-0:arm64 (1.24.2-1ubuntu0.2) over (1.24.2-1ubuntu0.1) ...
Preparing to unpack .../29-libheif-plugin-aomenc_1.17.6-1ubuntu4.10_arm64.deb ...
Unpacking libheif-plugin-aomenc:arm64 (1.17.6-1ubuntu4.10) over (1.17.6-1ubuntu4.9) ...
Preparing to unpack .../30-libheif-plugin-aomdec_1.17.6-1ubuntu4.10_arm64.deb ...
Unpacking libheif-plugin-aomdec:arm64 (1.17.6-1ubuntu4.10) over (1.17.6-1ubuntu4.9) ...
Preparing to unpack .../31-libheif1_1.17.6-1ubuntu4.10_arm64.deb ...
Unpacking libheif1:arm64 (1.17.6-1ubuntu4.10) over (1.17.6-1ubuntu4.9) ...
Preparing to unpack .../32-libmspack0t64_0.11-1.1ubuntu0.24.04.1_arm64.deb ...
Unpacking libmspack0t64:arm64 (0.11-1.1ubuntu0.24.04.1) over (0.11-1.1build1) ...
Preparing to unpack .../33-libnss3_2%3a3.98-1ubuntu0.3_arm64.deb ...
Unpacking libnss3:arm64 (2:3.98-1ubuntu0.3) over (2:3.98-1ubuntu0.2) ...
Preparing to unpack .../34-libssh-4_0.10.6-2ubuntu0.6_arm64.deb ...
Unpacking libssh-4:arm64 (0.10.6-2ubuntu0.6) over (0.10.6-2ubuntu0.5) ...
Preparing to unpack .../35-libtiff6_4.5.1+git230720-4ubuntu2.6_arm64.deb ...
Unpacking libtiff6:arm64 (4.5.1+git230720-4ubuntu2.6) over (4.5.1+git230720-4ubuntu2.5) ...
Selecting previously unselected package linux-headers-6.8.0-151.
Preparing to unpack .../36-linux-headers-6.8.0-151_6.8.0-151.151_all.deb ...
Unpacking linux-headers-6.8.0-151 (6.8.0-151.151) ...
Selecting previously unselected package linux-headers-6.8.0-151-generic.
Preparing to unpack .../37-linux-headers-6.8.0-151-generic_6.8.0-151.151_arm64.deb ...
Unpacking linux-headers-6.8.0-151-generic (6.8.0-151.151) ...
Selecting previously unselected package linux-modules-6.8.0-151-generic.
Preparing to unpack .../38-linux-modules-6.8.0-151-generic_6.8.0-151.151_arm64.deb ...
Unpacking linux-modules-6.8.0-151-generic (6.8.0-151.151) ...
Selecting previously unselected package linux-image-6.8.0-151-generic.
Preparing to unpack .../39-linux-image-6.8.0-151-generic_6.8.0-151.151_arm64.deb ...
Unpacking linux-image-6.8.0-151-generic (6.8.0-151.151) ...
Preparing to unpack .../40-linux-virtual_6.8.0-151.151_arm64.deb ...
Unpacking linux-virtual (6.8.0-151.151) over (6.8.0-147.147) ...
Preparing to unpack .../41-linux-image-virtual_6.8.0-151.151_arm64.deb ...
Unpacking linux-image-virtual (6.8.0-151.151) over (6.8.0-147.147) ...
Preparing to unpack .../42-linux-headers-virtual_6.8.0-151.151_arm64.deb ...
Unpacking linux-headers-virtual (6.8.0-151.151) over (6.8.0-147.147) ...
Preparing to unpack .../43-linux-headers-generic_6.8.0-151.151_arm64.deb ...
Unpacking linux-headers-generic (6.8.0-151.151) over (6.8.0-147.147) ...
Preparing to unpack .../44-linux-tools-common_6.8.0-151.151_all.deb ...
Unpacking linux-tools-common (6.8.0-151.151) over (6.8.0-147.147) ...
Selecting previously unselected package linux-tools-6.8.0-151.
Preparing to unpack .../45-linux-tools-6.8.0-151_6.8.0-151.151_arm64.deb ...
Unpacking linux-tools-6.8.0-151 (6.8.0-151.151) ...
Selecting previously unselected package linux-tools-6.8.0-151-generic.
Preparing to unpack .../46-linux-tools-6.8.0-151-generic_6.8.0-151.151_arm64.deb ...
Unpacking linux-tools-6.8.0-151-generic (6.8.0-151.151) ...
Preparing to unpack .../47-needrestart_3.6-7ubuntu4.6_all.deb ...
Unpacking needrestart (3.6-7ubuntu4.6) over (3.6-7ubuntu4.5) ...
Preparing to unpack .../48-python3-jwt_2.7.0-1ubuntu0.6_all.deb ...
Unpacking python3-jwt (2.7.0-1ubuntu0.6) over (2.7.0-1ubuntu0.3) ...
Preparing to unpack .../49-python3-oauthlib_3.2.2-1ubuntu0.1_all.deb ...
Unpacking python3-oauthlib (3.2.2-1ubuntu0.1) over (3.2.2-1) ...
Preparing to unpack .../50-python3-pyasn1_0.4.8-4ubuntu0.4_all.deb ...
Unpacking python3-pyasn1 (0.4.8-4ubuntu0.4) over (0.4.8-4ubuntu0.3) ...
Preparing to unpack .../51-python3-twisted_24.3.0-1ubuntu0.3_all.deb ...
Unpacking python3-twisted (24.3.0-1ubuntu0.3) over (24.3.0-1ubuntu0.2) ...
Preparing to unpack .../52-snapd_2.78+ubuntu24.04_arm64.deb ...
Unpacking snapd (2.78+ubuntu24.04) over (2.77.1+ubuntu24.04) ...
Preparing to unpack .../53-sosreport_4.11.2-0ubuntu0~24.04.2_arm64.deb ...
Unpacking sosreport (4.11.2-0ubuntu0~24.04.2) over (4.11.2-0ubuntu0~24.04.1) ...
Preparing to unpack .../54-tmux_3.4-1ubuntu0.2_arm64.deb ...
Unpacking tmux (3.4-1ubuntu0.2) over (3.4-1ubuntu0.1) ...
Preparing to unpack .../55-cloud-init_26.2-0ubuntu1~24.04.2_all.deb ...
Unpacking cloud-init (26.2-0ubuntu1~24.04.2) over (26.1-0ubuntu1~24.04.1) ...
Setting up libexpat1:arm64 (2.6.1-2ubuntu0.7) ...
Setting up systemd-sysv (255.4-1ubuntu8.19) ...
Setting up apt-utils (2.8.4ubuntu0.1) ...
Setting up python3-jwt (2.7.0-1ubuntu0.6) ...
Setting up distro-info-data (2026.10.12-0ubuntu0.24.04.1) ...
Setting up libbrotli1:arm64 (1.1.0-2ubuntu0.1) ...
Setting up libmspack0t64:arm64 (0.11-1.1ubuntu0.24.04.1) ...
Setting up linux-libc-dev:arm64 (6.8.0-151.151) ...
Setting up libnss-systemd:arm64 (255.4-1ubuntu8.19) ...
Setting up krb5-locales (1.20.1-6ubuntu2.12) ...
Setting up libnss3:arm64 (2:3.98-1ubuntu0.3) ...
Setting up locales (2.39-0ubuntu8.12) ...
Generating locales (this might take a while)...
  en_US.UTF-8... done
Generation complete.
Setting up libelf1t64:arm64 (0.190-1.1ubuntu0.2) ...
Setting up libkrb5support0:arm64 (1.20.1-6ubuntu2.12) ...
Setting up libdw1t64:arm64 (0.190-1.1ubuntu0.2) ...
Setting up tzdata (2026f-0ubuntu0.24.04.1) ...

Current default time zone: 'Etc/UTC'
Local time is now:      Thu Nov 26 23:45:48 UTC 2026.
Universal Time is now:  Thu Nov 26 23:45:48 UTC 2026.
Run 'dpkg-reconfigure tzdata' if you wish to change it.

Setting up ca-certificates (20260816ubuntu0.24.04.2) ...
Updating certificates in /etc/ssl/certs...
rehash: warning: skipping ca-certificates.crt,it does not contain exactly one certificate or CRL
4 added, 5 removed; done.
Running hooks in /etc/ca-certificates/update.d...
done.
Setting up libglib2.0-0t64:arm64 (2.80.0-6ubuntu3.10) ...
No schema files found: doing nothing.
Setting up libglib2.0-data (2.80.0-6ubuntu3.10) ...
Setting up python3-oauthlib (3.2.2-1ubuntu0.1) ...
Setting up python3-twisted (24.3.0-1ubuntu0.3) ...
Setting up xz-utils (5.6.1+really5.4.5-1ubuntu0.4) ...
Setting up perl-modules-5.38 (5.38.2-3.2ubuntu0.7) ...
Setting up linux-headers-6.8.0-151 (6.8.0-151.151) ...
Setting up systemd-timesyncd (255.4-1ubuntu8.19) ...
systemd-timesyncd.service is a disabled or a static unit not running, not starting it.
Setting up udev (255.4-1ubuntu8.19) ...
Setting up gir1.2-glib-2.0:arm64 (2.80.0-6ubuntu3.10) ...
Setting up libk5crypto3:arm64 (1.20.1-6ubuntu2.12) ...
Setting up sosreport (4.11.2-0ubuntu0~24.04.2) ...
Setting up libtiff6:arm64 (4.5.1+git230720-4ubuntu2.6) ...
Setting up python3-pyasn1 (0.4.8-4ubuntu0.4) ...
Setting up libpam-systemd:arm64 (255.4-1ubuntu8.19) ...
Setting up linux-modules-6.8.0-151-generic (6.8.0-151.151) ...
Setting up git-man (1:2.43.0-1ubuntu7.4) ...
Setting up libpcap0.8t64:arm64 (1.10.4-4.1ubuntu3.2) ...
Setting up libkrb5-3:arm64 (1.20.1-6ubuntu2.12) ...
Setting up libperl5.38t64:arm64 (5.38.2-3.2ubuntu0.7) ...
Setting up libc-dev-bin (2.39-0ubuntu8.12) ...
Setting up linux-tools-common (6.8.0-151.151) ...
Setting up python3-distro-info (1.7ubuntu0.1) ...
Setting up tmux (3.4-1ubuntu0.2) ...
Setting up libgstreamer1.0-0:arm64 (1.24.2-1ubuntu0.2) ...
Setcap worked! gst-ptp-helper is not suid!
Setting up libc-devtools (2.39-0ubuntu8.12) ...
Setting up systemd-resolved (255.4-1ubuntu8.19) ...
Setting up distro-info (1.7ubuntu0.1) ...
Setting up snapd (2.78+ubuntu24.04) ...
snapd.socket is a disabled or a static unit not running, not starting it.
snapd.service is a disabled or a static unit not running, not starting it.
snapd.failure.service is a disabled or a static unit not running, not starting it.
snapd.gpio-chardev-setup.target is a disabled or a static unit not running, not starting it.
snapd.seeded.service is a disabled or a static unit not running, not starting it.
snapd.snap-repair.service is a disabled or a static unit not running, not starting it.
Setting up cloud-init (26.2-0ubuntu1~24.04.2) ...
Installing new version of config file /etc/cloud/templates/hosts.azurelinux.tmpl ...
Installing new version of config file /etc/cloud/templates/sources.list.debian.tmpl ...
Installing new version of config file /etc/profile.d/Z99-cloud-locale-test.sh ...
Installing new version of config file /etc/profile.d/Z99-cloudinit-warnings.sh ...
Setting up libglib2.0-bin (2.80.0-6ubuntu3.10) ...
Setting up linux-tools-6.8.0-151 (6.8.0-151.151) ...
Setting up perl (5.38.2-3.2ubuntu0.7) ...
Setting up linux-headers-6.8.0-151-generic (6.8.0-151.151) ...
Setting up libgssapi-krb5-2:arm64 (1.20.1-6ubuntu2.12) ...
Setting up git (1:2.43.0-1ubuntu7.4) ...
Setting up linux-image-6.8.0-151-generic (6.8.0-151.151) ...
I: /boot/vmlinuz is now a symlink to vmlinuz-6.8.0-151-generic
I: /boot/initrd.img is now a symlink to initrd.img-6.8.0-151-generic
Setting up libssh-4:arm64 (0.10.6-2ubuntu0.6) ...
Setting up linux-tools-6.8.0-151-generic (6.8.0-151.151) ...
Setting up libc6-dev:arm64 (2.39-0ubuntu8.12) ...
Setting up linux-image-virtual (6.8.0-151.151) ...
Setting up ubuntu-pro-client (38ubuntu0~24.04) ...
Installing new version of config file /etc/apparmor.d/ubuntu_pro_esm_cache ...
ua-timer.timer is a disabled or a static unit, not starting it.
ubuntu-advantage.service is a disabled or a static unit, not starting it.
Setting up ubuntu-pro-client-l10n (38ubuntu0~24.04) ...
Setting up needrestart (3.6-7ubuntu4.6) ...
Installing new version of config file /etc/needrestart/notify.d/400-notify-send ...
Setting up bind9-libs:arm64 (1:9.18.39-0ubuntu0.24.04.9) ...
Setting up linux-headers-generic (6.8.0-151.151) ...
Setting up bind9-host (1:9.18.39-0ubuntu0.24.04.9) ...
Setting up linux-headers-virtual (6.8.0-151.151) ...
Setting up linux-virtual (6.8.0-151.151) ...
Setting up bind9-dnsutils (1:9.18.39-0ubuntu0.24.04.9) ...
Setting up libheif-plugin-aomdec:arm64 (1.17.6-1ubuntu4.10) ...
Setting up libheif1:arm64 (1.17.6-1ubuntu4.10) ...
Setting up libheif-plugin-aomenc:arm64 (1.17.6-1ubuntu4.10) ...
Processing triggers for libc-bin (2.39-0ubuntu8.12) ...
Processing triggers for rsyslog (8.2312.0-3ubuntu9.4) ...
Processing triggers for man-db (2.12.0-4build2) ...
Processing triggers for dbus (1.14.10-4ubuntu4.1) ...
Processing triggers for debianutils (5.17build1) ...
Processing triggers for initramfs-tools (0.142ubuntu25.8) ...
update-initramfs: Generating /boot/initrd.img-6.8.0-147-generic
Ignoring old or unknown version 6.8.0-147-generic (latest is 6.8.0-151-generic)
Processing triggers for linux-image-6.8.0-151-generic (6.8.0-151.151) ...
/etc/kernel/postinst.d/initramfs-tools:
update-initramfs: Generating /boot/initrd.img-6.8.0-151-generic
flash-kernel: deferring update (trigger activated)
/etc/kernel/postinst.d/zz-flash-kernel:
flash-kernel: deferring update (trigger activated)
/etc/kernel/postinst.d/zz-update-grub:
Sourcing file `/etc/default/grub'
Sourcing file `/etc/default/grub.d/50-cloudimg-settings.cfg'
Generating grub configuration file ...
Found linux image: /boot/vmlinuz-6.8.0-151-generic
Found initrd image: /boot/initrd.img-6.8.0-151-generic
Found linux image: /boot/vmlinuz-6.8.0-147-generic
Found initrd image: /boot/initrd.img-6.8.0-147-generic
Warning: os-prober will not be executed to detect other bootable partitions.
Systems on them will not be added to the GRUB boot configuration.
Check GRUB_DISABLE_OS_PROBER documentation entry.
Adding boot menu entry for UEFI Firmware Settings ...
done
Processing triggers for flash-kernel (3.107ubuntu13~24.04.6) ...
System running in EFI mode, skipping.

Restarting services...
 /etc/needrestart/restart.d/systemd-manager
 systemctl restart cron.service multipathd.service packagekit.service polkit.service ssh.service systemd-journald.service systemd-networkd.service udisks2.service

Service restarts being deferred:
 systemctl restart ModemManager.service
 /etc/needrestart/restart.d/dbus.service
 systemctl restart getty@tty1.service
 systemctl restart serial-getty@hvc0.service
 systemctl restart systemd-logind.service

No containers need to be restarted.

User sessions running outdated binaries:
 p2party @ session #6: cloud-init[2396], sh[2399], sshd[2262]
 p2party @ user manager service: systemd[2055]

No VM guests are running outdated hypervisor (qemu) binaries on this host.
2026-11-26 23:48:05,234 - log_util.py[WARNING]: Package upgrade failed
Reading package lists...
Building dependency tree...
Reading state information...
ufw is already the newest version (0.36.2-6).
ufw set to manually installed.
The following additional packages will be installed:
  python3-pyasyncore python3-pyinotify whois
Suggested packages:
  mailx monit sqlite3 python-pyinotify-doc zip
The following NEW packages will be installed:
  fail2ban net-tools python3-pyasyncore python3-pyinotify unzip whois
0 upgraded, 6 newly installed, 0 to remove and 1 not upgraded.
Need to get 873 kB of archives.
After this operation, 4386 kB of additional disk space will be used.
Get:1 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 python3-pyasyncore all 1.0.2-2 [10.1 kB]
Get:2 http://ports.ubuntu.com/ubuntu-ports noble-updates/universe arm64 fail2ban all 1.0.2-3ubuntu0.1 [409 kB]
Get:3 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 net-tools arm64 2.10-0.1ubuntu4.4 [207 kB]
Get:4 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 python3-pyinotify all 0.9.6-2ubuntu1 [25.0 kB]
Get:5 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 unzip arm64 6.0-28ubuntu4.1 [171 kB]
Get:6 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 whois arm64 5.5.22 [50.3 kB]
Fetched 873 kB in 1s (1487 kB/s)
Selecting previously unselected package python3-pyasyncore.
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 112387 files and directories currently installed.)
Preparing to unpack .../0-python3-pyasyncore_1.0.2-2_all.deb ...
Unpacking python3-pyasyncore (1.0.2-2) ...
Selecting previously unselected package fail2ban.
Preparing to unpack .../1-fail2ban_1.0.2-3ubuntu0.1_all.deb ...
Unpacking fail2ban (1.0.2-3ubuntu0.1) ...
Selecting previously unselected package net-tools.
Preparing to unpack .../2-net-tools_2.10-0.1ubuntu4.4_arm64.deb ...
Unpacking net-tools (2.10-0.1ubuntu4.4) ...
Selecting previously unselected package python3-pyinotify.
Preparing to unpack .../3-python3-pyinotify_0.9.6-2ubuntu1_all.deb ...
Unpacking python3-pyinotify (0.9.6-2ubuntu1) ...
Selecting previously unselected package unzip.
Preparing to unpack .../4-unzip_6.0-28ubuntu4.1_arm64.deb ...
Unpacking unzip (6.0-28ubuntu4.1) ...
Selecting previously unselected package whois.
Preparing to unpack .../5-whois_5.5.22_arm64.deb ...
Unpacking whois (5.5.22) ...
Setting up net-tools (2.10-0.1ubuntu4.4) ...
Setting up whois (5.5.22) ...
Setting up unzip (6.0-28ubuntu4.1) ...
Setting up python3-pyasyncore (1.0.2-2) ...
Setting up fail2ban (1.0.2-3ubuntu0.1) ...
/usr/lib/python3/dist-packages/fail2ban/tests/fail2banregextestcase.py:224: SyntaxWarning: invalid escape sequence '\s'
  "1490349000 test failed.dns.ch", "^\s*test <F-ID>\S+</F-ID>"
/usr/lib/python3/dist-packages/fail2ban/tests/fail2banregextestcase.py:435: SyntaxWarning: invalid escape sequence '\S'
  '^'+prefix+'<F-ID>User <F-USER>\S+</F-USER></F-ID> not allowed\n'
/usr/lib/python3/dist-packages/fail2ban/tests/fail2banregextestcase.py:443: SyntaxWarning: invalid escape sequence '\S'
  '^'+prefix+'User <F-USER>\S+</F-USER> not allowed\n'
/usr/lib/python3/dist-packages/fail2ban/tests/fail2banregextestcase.py:444: SyntaxWarning: invalid escape sequence '\d'
  '^'+prefix+'Received disconnect from <F-ID><ADDR> port \d+</F-ID>'
/usr/lib/python3/dist-packages/fail2ban/tests/fail2banregextestcase.py:451: SyntaxWarning: invalid escape sequence '\s'
  _test_variants('common', prefix="\s*\S+ sshd\[<F-MLFID>\d+</F-MLFID>\]:\s+")
/usr/lib/python3/dist-packages/fail2ban/tests/fail2banregextestcase.py:537: SyntaxWarning: invalid escape sequence '\['
  'common[prefregex="^svc\[<F-MLFID>\d+</F-MLFID>\] connect <F-CONTENT>.+</F-CONTENT>$"'
/usr/lib/python3/dist-packages/fail2ban/tests/servertestcase.py:1375: SyntaxWarning: invalid escape sequence '\s'
  "`{ nft -a list chain inet f2b-table f2b-chain | grep -oP '@addr-set-j-w-nft-mp\s+.*\s+\Khandle\s+(\d+)$'; } | while read -r hdl; do`",
/usr/lib/python3/dist-packages/fail2ban/tests/servertestcase.py:1378: SyntaxWarning: invalid escape sequence '\s'
  "`{ nft -a list chain inet f2b-table f2b-chain | grep -oP '@addr6-set-j-w-nft-mp\s+.*\s+\Khandle\s+(\d+)$'; } | while read -r hdl; do`",
/usr/lib/python3/dist-packages/fail2ban/tests/servertestcase.py:1421: SyntaxWarning: invalid escape sequence '\s'
  "`{ nft -a list chain inet f2b-table f2b-chain | grep -oP '@addr-set-j-w-nft-ap\s+.*\s+\Khandle\s+(\d+)$'; } | while read -r hdl; do`",
/usr/lib/python3/dist-packages/fail2ban/tests/servertestcase.py:1424: SyntaxWarning: invalid escape sequence '\s'
  "`{ nft -a list chain inet f2b-table f2b-chain | grep -oP '@addr6-set-j-w-nft-ap\s+.*\s+\Khandle\s+(\d+)$'; } | while read -r hdl; do`",
Created symlink /etc/systemd/system/multi-user.target.wants/fail2ban.service → /usr/lib/systemd/system/fail2ban.service.

Setting up python3-pyinotify (0.9.6-2ubuntu1) ...
Processing triggers for man-db (2.12.0-4build2) ...

Restarting services...

Service restarts being deferred:
 /etc/needrestart/restart.d/dbus.service
 systemctl restart getty@tty1.service
 systemctl restart serial-getty@hvc0.service
 systemctl restart systemd-logind.service

No containers need to be restarted.

User sessions running outdated binaries:
 p2party @ session #6: cloud-init[2396], sh[2399], sshd[2262]
 p2party @ user manager service: systemd[2055]

No VM guests are running outdated hypervisor (qemu) binaries on this host.
2026-11-26 23:48:09,974 - cc_package_update_upgrade_install.py[WARNING]: 1 failed with exceptions, re-raising the last one
2026-11-26 23:48:09,974 - log_util.py[WARNING]: Running module package_update_upgrade_install (<module 'cloudinit.config.cc_package_update_upgrade_install' from '/usr/lib/python3/dist-packages/cloudinit/config/cc_package_update_upgrade_install.py'>) failed
2026-11-26 23:48:09,975 - main.py[WARNING]: Ran package_update_upgrade_install but it failed!
  File "/usr/lib/python3/dist-packages/cloudinit/distros/package_management/snap.py", line 57, in upgrade_packages
    subp.subp(["snap", "refresh"])
Command: ['snap', 'refresh']
Stderr: error: cannot communicate with server: Post "http://localhost/v2/snaps": dial unix /run/snapd.socket: connect: no such file or directory
Cloud-init v. 26.2-0ubuntu1~24.04.2 running 'single' at Thu, 26 Nov 2026 23:48:10 +0000. Up 181.87 seconds.
Cloud-init v. 26.2-0ubuntu1~24.04.2 running 'single' at Thu, 26 Nov 2026 23:48:10 +0000. Up 182.22 seconds.
Cloud-init v. 26.2-0ubuntu1~24.04.2 running 'single' at Thu, 26 Nov 2026 23:48:11 +0000. Up 182.48 seconds.
Synchronizing state of fail2ban.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.
Executing: /usr/lib/systemd/systemd-sysv-install enable fail2ban
Default incoming policy changed to 'deny'
(be sure to update your rules accordingly)
Default outgoing policy changed to 'allow'
(be sure to update your rules accordingly)
Rules updated
Rules updated
Rules updated (v6)
Rules updated
Rules updated (v6)
Firewall is active and enabled on system startup
Signaling host ready (service will be deployed via Ansible)
```

- The runcmd's `reboot` restarted the guest; Lima reconnected.

After the reboot (provisioning marker, firewall, effective sshd settings):

```text
Cloud-init complete
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    192.168.5.0/24             # rehearsal: Lima SSH, stands in for the private network
22/tcp                     ALLOW IN    10.231.0.0/24               # SSH from private net
80/tcp                     ALLOW IN    Anywhere                   # HTTP ACME
443/tcp                    ALLOW IN    Anywhere                   # HTTPS Caddy
80/tcp (v6)                ALLOW IN    Anywhere (v6)              # HTTP ACME
443/tcp (v6)               ALLOW IN    Anywhere (v6)              # HTTPS Caddy

port 22
permitrootlogin no
passwordauthentication no
allowtcpforwarding no
allowusers p2party
authenticationmethods any
```

Stand-in `private-network` (exit 0):

```text
p2party0         UNKNOWN        10.231.0.2/24 10.231.0.4/24
```

Stand-in `amd64-runtime` (exit 0):

```text
Get:1 http://archive.ubuntu.com/ubuntu noble InRelease [256 kB]
Hit:2 http://ports.ubuntu.com/ubuntu-ports noble InRelease
Hit:3 http://ports.ubuntu.com/ubuntu-ports noble-updates InRelease
Hit:4 http://ports.ubuntu.com/ubuntu-ports noble-backports InRelease
Hit:5 http://ports.ubuntu.com/ubuntu-ports noble-security InRelease
Get:6 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]
Get:7 http://archive.ubuntu.com/ubuntu noble-security InRelease [126 kB]
Get:8 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages [1401 kB]
Get:9 http://archive.ubuntu.com/ubuntu noble/main Translation-en [513 kB]
Get:10 http://archive.ubuntu.com/ubuntu noble/main arm64 Components [460 kB]
Get:11 http://archive.ubuntu.com/ubuntu noble/main arm64 c-n-f Metadata [30.0 kB]
Get:12 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages [1492 kB]
Get:13 http://archive.ubuntu.com/ubuntu noble-updates/main Translation-en [321 kB]
Get:14 http://archive.ubuntu.com/ubuntu noble-updates/main arm64 Components [178 kB]
Get:15 http://archive.ubuntu.com/ubuntu noble-updates/main arm64 c-n-f Metadata [17.4 kB]
Get:16 http://archive.ubuntu.com/ubuntu noble-security/main amd64 Packages [1231 kB]
Get:17 http://archive.ubuntu.com/ubuntu noble-security/main Translation-en [243 kB]
Get:18 http://archive.ubuntu.com/ubuntu noble-security/main arm64 Components [43.3 kB]
Get:19 http://archive.ubuntu.com/ubuntu noble-security/main arm64 c-n-f Metadata [11.6 kB]
Fetched 6450 kB in 1s (5359 kB/s)
Reading package lists...
Reading package lists...
Building dependency tree...
Reading state information...
The following additional packages will be installed:
  gcc-14-base:amd64 libidn2-0:amd64 libunistring5:amd64
Suggested packages:
  glibc-doc:amd64 locales:amd64 libnss-nis:amd64 libnss-nisplus:amd64
The following NEW packages will be installed:
  gcc-14-base:amd64 libc6:amd64 libgcc-s1:amd64 libidn2-0:amd64
  libssl3t64:amd64 libunistring5:amd64 zlib1g:amd64
0 upgraded, 7 newly installed, 0 to remove and 1 not upgraded.
Need to get 6004 kB of archives.
After this operation, 23.0 MB of additional disk space will be used.
Get:1 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 gcc-14-base amd64 14.2.0-4ubuntu2~24.04.1 [51.0 kB]
Get:2 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 libgcc-s1 amd64 14.2.0-4ubuntu2~24.04.1 [78.4 kB]
Get:3 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 libc6 amd64 2.39-0ubuntu8.12 [3264 kB]
Get:4 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 libssl3t64 amd64 3.0.13-0ubuntu3.16 [1945 kB]
Get:5 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 zlib1g amd64 1:1.3.dfsg-3.1ubuntu2.3 [63.2 kB]
Get:6 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 libunistring5 amd64 1.1-2build1.1 [536 kB]
Get:7 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 libidn2-0 amd64 2.3.7-2build1.1 [66.2 kB]
Preconfiguring packages ...
Fetched 6004 kB in 1s (8298 kB/s)
Selecting previously unselected package gcc-14-base:amd64.
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 112941 files and directories currently installed.)
Preparing to unpack .../0-gcc-14-base_14.2.0-4ubuntu2~24.04.1_amd64.deb ...
Unpacking gcc-14-base:amd64 (14.2.0-4ubuntu2~24.04.1) ...
Selecting previously unselected package libgcc-s1:amd64.
Preparing to unpack .../1-libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb ...
Unpacking libgcc-s1:amd64 (14.2.0-4ubuntu2~24.04.1) ...
Selecting previously unselected package libc6:amd64.
Preparing to unpack .../2-libc6_2.39-0ubuntu8.12_amd64.deb ...
Unpacking libc6:amd64 (2.39-0ubuntu8.12) ...
Selecting previously unselected package libssl3t64:amd64.
Preparing to unpack .../3-libssl3t64_3.0.13-0ubuntu3.16_amd64.deb ...
Unpacking libssl3t64:amd64 (3.0.13-0ubuntu3.16) ...
Selecting previously unselected package zlib1g:amd64.
Preparing to unpack .../4-zlib1g_1%3a1.3.dfsg-3.1ubuntu2.3_amd64.deb ...
Unpacking zlib1g:amd64 (1:1.3.dfsg-3.1ubuntu2.3) ...
Selecting previously unselected package libunistring5:amd64.
Preparing to unpack .../5-libunistring5_1.1-2build1.1_amd64.deb ...
Unpacking libunistring5:amd64 (1.1-2build1.1) ...
Selecting previously unselected package libidn2-0:amd64.
Preparing to unpack .../6-libidn2-0_2.3.7-2build1.1_amd64.deb ...
Unpacking libidn2-0:amd64 (2.3.7-2build1.1) ...
Setting up gcc-14-base:amd64 (14.2.0-4ubuntu2~24.04.1) ...
Setting up libgcc-s1:amd64 (14.2.0-4ubuntu2~24.04.1) ...
Setting up libc6:amd64 (2.39-0ubuntu8.12) ...
Setting up libssl3t64:amd64 (3.0.13-0ubuntu3.16) ...
Setting up zlib1g:amd64 (1:1.3.dfsg-3.1ubuntu2.3) ...
Setting up libunistring5:amd64 (1.1-2build1.1) ...
Setting up libidn2-0:amd64 (2.3.7-2build1.1) ...
Processing triggers for libc-bin (2.39-0ubuntu8.12) ...

Running kernel seems to be up-to-date.

No services need to be restarted.

No containers need to be restarted.

No user sessions are running outdated binaries.

No VM guests are running outdated hypervisor (qemu) binaries on this host.
libc6:amd64 2.39-0ubuntu8.12
libssl3t64:amd64 3.0.13-0ubuntu3.16
```

Stand-in `no-prisma-checkpoint` (exit 0):

```text

```

Stand-in `postgresql-from-ubuntu` (exit 0):

```text
Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease
Hit:2 http://ports.ubuntu.com/ubuntu-ports noble InRelease
Hit:3 http://archive.ubuntu.com/ubuntu noble-updates InRelease
Hit:4 http://ports.ubuntu.com/ubuntu-ports noble-updates InRelease
Hit:5 http://archive.ubuntu.com/ubuntu noble-security InRelease
Hit:6 http://ports.ubuntu.com/ubuntu-ports noble-backports InRelease
Hit:7 http://ports.ubuntu.com/ubuntu-ports noble-security InRelease
Reading package lists...
Reading package lists...
Building dependency tree...
Reading state information...
The following additional packages will be installed:
  libcommon-sense-perl libjson-perl libjson-xs-perl libllvm17t64 libpq5
  libtypes-serialiser-perl postgresql-client-16 postgresql-client-common
  postgresql-common ssl-cert
Suggested packages:
  postgresql-doc-16 python-psycopg2-doc
The following NEW packages will be installed:
  libcommon-sense-perl libjson-perl libjson-xs-perl libllvm17t64 libpq5
  libtypes-serialiser-perl postgresql-16 postgresql-client-16
  postgresql-client-common postgresql-common python3-psycopg2 ssl-cert
0 upgraded, 12 newly installed, 0 to remove and 1 not upgraded.
Need to get 42.4 MB of archives.
After this operation, 176 MB of additional disk space will be used.
Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 libjson-perl all 4.10000-1 [81.9 kB]
Get:2 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 libcommon-sense-perl arm64 3.75-3build3 [20.4 kB]
Get:3 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 postgresql-client-common all 257build1.1 [36.4 kB]
Get:4 http://archive.ubuntu.com/ubuntu noble/main amd64 ssl-cert all 1.1.2ubuntu1 [17.8 kB]
Get:5 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 postgresql-common all 257build1.1 [161 kB]
Get:6 http://archive.ubuntu.com/ubuntu noble/main amd64 libtypes-serialiser-perl all 1.01-1 [11.6 kB]
Get:7 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libjson-xs-perl arm64 4.040-0ubuntu0.24.04.1 [83.3 kB]
Get:8 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 libllvm17t64 arm64 1:17.0.6-9ubuntu1 [25.0 MB]
Get:9 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 libpq5 arm64 16.15-0ubuntu0.24.04.1 [149 kB]
Get:10 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 postgresql-client-16 arm64 16.15-0ubuntu0.24.04.1 [1293 kB]
Get:11 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 postgresql-16 arm64 16.15-0ubuntu0.24.04.1 [15.4 MB]
Get:12 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 python3-psycopg2 arm64 2.9.9-1build1 [130 kB]
Preconfiguring packages ...
Fetched 42.4 MB in 3s (16.9 MB/s)
Selecting previously unselected package libjson-perl.
(Reading database ...
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 113241 files and directories currently installed.)
Preparing to unpack .../00-libjson-perl_4.10000-1_all.deb ...
Unpacking libjson-perl (4.10000-1) ...
Selecting previously unselected package postgresql-client-common.
Preparing to unpack .../01-postgresql-client-common_257build1.1_all.deb ...
Unpacking postgresql-client-common (257build1.1) ...
Selecting previously unselected package ssl-cert.
Preparing to unpack .../02-ssl-cert_1.1.2ubuntu1_all.deb ...
Unpacking ssl-cert (1.1.2ubuntu1) ...
Selecting previously unselected package postgresql-common.
Preparing to unpack .../03-postgresql-common_257build1.1_all.deb ...
Adding 'diversion of /usr/bin/pg_config to /usr/bin/pg_config.libpq-dev by postgresql-common'
Unpacking postgresql-common (257build1.1) ...
Selecting previously unselected package libcommon-sense-perl:arm64.
Preparing to unpack .../04-libcommon-sense-perl_3.75-3build3_arm64.deb ...
Unpacking libcommon-sense-perl:arm64 (3.75-3build3) ...
Selecting previously unselected package libtypes-serialiser-perl.
Preparing to unpack .../05-libtypes-serialiser-perl_1.01-1_all.deb ...
Unpacking libtypes-serialiser-perl (1.01-1) ...
Selecting previously unselected package libjson-xs-perl.
Preparing to unpack .../06-libjson-xs-perl_4.040-0ubuntu0.24.04.1_arm64.deb ...
Unpacking libjson-xs-perl (4.040-0ubuntu0.24.04.1) ...
Selecting previously unselected package libllvm17t64:arm64.
Preparing to unpack .../07-libllvm17t64_1%3a17.0.6-9ubuntu1_arm64.deb ...
Unpacking libllvm17t64:arm64 (1:17.0.6-9ubuntu1) ...
Selecting previously unselected package libpq5:arm64.
Preparing to unpack .../08-libpq5_16.15-0ubuntu0.24.04.1_arm64.deb ...
Unpacking libpq5:arm64 (16.15-0ubuntu0.24.04.1) ...
Selecting previously unselected package postgresql-client-16.
Preparing to unpack .../09-postgresql-client-16_16.15-0ubuntu0.24.04.1_arm64.deb ...
Unpacking postgresql-client-16 (16.15-0ubuntu0.24.04.1) ...
Selecting previously unselected package postgresql-16.
Preparing to unpack .../10-postgresql-16_16.15-0ubuntu0.24.04.1_arm64.deb ...
Unpacking postgresql-16 (16.15-0ubuntu0.24.04.1) ...
Selecting previously unselected package python3-psycopg2.
Preparing to unpack .../11-python3-psycopg2_2.9.9-1build1_arm64.deb ...
Unpacking python3-psycopg2 (2.9.9-1build1) ...
Setting up postgresql-client-common (257build1.1) ...
Setting up libpq5:arm64 (16.15-0ubuntu0.24.04.1) ...
Setting up libcommon-sense-perl:arm64 (3.75-3build3) ...
Setting up libllvm17t64:arm64 (1:17.0.6-9ubuntu1) ...
Setting up ssl-cert (1.1.2ubuntu1) ...
Created symlink /etc/systemd/system/multi-user.target.wants/ssl-cert.service → /usr/lib/systemd/system/ssl-cert.service.

Setting up python3-psycopg2 (2.9.9-1build1) ...
Setting up libtypes-serialiser-perl (1.01-1) ...
Setting up libjson-perl (4.10000-1) ...
Setting up libjson-xs-perl (4.040-0ubuntu0.24.04.1) ...
Setting up postgresql-client-16 (16.15-0ubuntu0.24.04.1) ...
update-alternatives: using /usr/share/postgresql/16/man/man1/psql.1.gz to provide /usr/share/man/man1/psql.1.gz (psql.1.gz) in auto mode
Setting up postgresql-common (257build1.1) ...

Creating config file /etc/postgresql-common/createcluster.conf with new version
Building PostgreSQL dictionaries from installed myspell/hunspell packages...
Removing obsolete dictionary files:
Created symlink /etc/systemd/system/multi-user.target.wants/postgresql.service → /usr/lib/systemd/system/postgresql.service.

Setting up postgresql-16 (16.15-0ubuntu0.24.04.1) ...
Creating new PostgreSQL cluster 16/main ...
/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/16/main --auth-local peer --auth-host scram-sha-256 --no-instructions
The files belonging to this database system will be owned by user "postgres".
This user must also own the server process.

The database cluster will be initialized with locale "C.UTF-8".
The default database encoding has accordingly been set to "UTF8".
The default text search configuration will be set to "english".

Data page checksums are disabled.

fixing permissions on existing directory /var/lib/postgresql/16/main ... ok
creating subdirectories ... ok
selecting dynamic shared memory implementation ... posix
selecting default max_connections ... 100
selecting default shared_buffers ... 128MB
selecting default time zone ... Etc/UTC
creating configuration files ... ok
running bootstrap script ... ok
performing post-bootstrap initialization ... ok
syncing data to disk ... ok
Processing triggers for man-db (2.12.0-4build2) ...
Processing triggers for libc-bin (2.39-0ubuntu8.12) ...

Running kernel seems to be up-to-date.

No services need to be restarted.

No containers need to be restarted.

No user sessions are running outdated binaries.

No VM guests are running outdated hypervisor (qemu) binaries on this host.
psql (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
```

Stand-in `caddy-from-ubuntu` (exit 0):

```text

```

Stand-in `host-bun` (exit 0):

```text
1.4.5
```

Stand-in `coturn-certificate` (exit 0):

```text
subject=CN = turn.rehearsal.localhost
```

## site.yml

site.yml --skip-tags coturn (exit 2):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Verify Infrastructure Health] ********************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-postgres]
ok: [p2party-signaling]
ok: [p2party-coturn]

TASK [Display host info] *******************************************************
ok: [p2party-postgres] => {
    "msg": "p2party-postgres (127.0.0.1) - database"
}
ok: [p2party-signaling] => {
    "msg": "p2party-signaling (127.0.0.1) - signaling"
}
ok: [p2party-coturn] => {
    "msg": "p2party-coturn (127.0.0.1) - turn"
}

TASK [Verify SSH connectivity] *************************************************
ok: [p2party-postgres]
ok: [p2party-signaling]
ok: [p2party-coturn]

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Install and Configure PostgreSQL] ****************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-postgres]

TASK [Check if PostgreSQL is already installed] ********************************
ok: [$REDACTED$-postgres]

TASK [Install prerequisites] ***************************************************
skipping: [$REDACTED$-postgres]

TASK [Add PostgreSQL GPG key] **************************************************
skipping: [$REDACTED$-postgres]

TASK [Add PostgreSQL repository] ***********************************************
skipping: [$REDACTED$-postgres]

TASK [Update apt cache] ********************************************************
skipping: [$REDACTED$-postgres]

TASK [Install PostgreSQL 17] ***************************************************
skipping: [$REDACTED$-postgres]

TASK [Ensure PostgreSQL is started] ********************************************
ok: [$REDACTED$-postgres]

PLAY [Configure PostgreSQL] ****************************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-postgres]

TASK [Get PostgreSQL version directory] ****************************************
ok: [$REDACTED$-postgres]

TASK [Configure PostgreSQL to listen on all interfaces] ************************
[WARNING]: Module remote_tmp /root/.ansible/tmp did not exist and was created with a mode of 0700, this may cause issues when running as another user. To avoid this, create the remote_tmp dir with the correct permissions manually
changed: [$REDACTED$-postgres]

TASK [Configure PostgreSQL performance settings] *******************************
changed: [$REDACTED$-postgres]

TASK [Configure pg_hba.conf for private network access] ************************
changed: [$REDACTED$-postgres]

RUNNING HANDLER [Restart PostgreSQL] *******************************************
changed: [$REDACTED$-postgres]

PLAY [Create Database and User] ************************************************

TASK [Gathering Facts] *********************************************************
[WARNING]: Module remote_tmp /var/lib/postgresql/.ansible/tmp did not exist and was created with a mode of 0700, this may cause issues when running as another user. To avoid this, create the remote_tmp dir with the correct permissions manually
ok: [$REDACTED$-postgres]

TASK [Create database user] ****************************************************
changed: [$REDACTED$-postgres]

TASK [Create database] *********************************************************
changed: [$REDACTED$-postgres]

TASK [Display completion message] **********************************************
ok: [$REDACTED$-postgres] => {
    "msg": "PostgreSQL setup complete!\n- Database: $REDACTED$ (user: $REDACTED$)\n- Listening on: 10.231.0.2:5432\n"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-postgres]

TASK [Install certificate tooling] *********************************************
ok: [$REDACTED$-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
changed: [$REDACTED$-postgres]

TASK [Create a local database trust anchor] ************************************
changed: [$REDACTED$-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [$REDACTED$-postgres]

TASK [Create the database server key and signing request] **********************
changed: [$REDACTED$-postgres]

TASK [Set the authenticated database address and server usage] *****************
changed: [$REDACTED$-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [$REDACTED$-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
changed: [$REDACTED$-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [$REDACTED$-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [$REDACTED$-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [$REDACTED$-postgres] => (item=ca.key)
ok: [$REDACTED$-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [$REDACTED$-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
changed: [$REDACTED$-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
changed: [$REDACTED$-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [$REDACTED$-postgres]

RUNNING HANDLER [Restart PostgreSQL for verified TLS] **************************
changed: [$REDACTED$-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
changed: [$REDACTED$-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
changed: [$REDACTED$-signaling]

PLAY [Check this machine's toolchain before any host is contacted] *************

PLAY [Setup Coturn TURN/STUN Server] *******************************************

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-postgres]

TASK [Install certificate tooling] *********************************************
ok: [$REDACTED$-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [$REDACTED$-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [$REDACTED$-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [$REDACTED$-postgres]

TASK [Create the database server key and signing request] **********************
ok: [$REDACTED$-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [$REDACTED$-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [$REDACTED$-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [$REDACTED$-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [$REDACTED$-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [$REDACTED$-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [$REDACTED$-postgres] => (item=ca.key)
ok: [$REDACTED$-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [$REDACTED$-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [$REDACTED$-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [$REDACTED$-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [$REDACTED$-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [$REDACTED$-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [$REDACTED$-signaling]

PLAY [Pre-flight checks] *******************************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Verify SSH connectivity] *************************************************
ok: [$REDACTED$-signaling]

TASK [Display target info] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "Setting up signaling server on $REDACTED$-signaling (127.0.0.1)"
}

PLAY [Install Bun on Signaling Server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Check if Bun is installed] ***********************************************
ok: [$REDACTED$-signaling]

TASK [Install unzip (required for Bun)] ****************************************
skipping: [$REDACTED$-signaling]

TASK [Install Bun via official installer] **************************************
skipping: [$REDACTED$-signaling]

TASK [Verify Bun installation] *************************************************
ok: [$REDACTED$-signaling]

TASK [Display Bun version] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "Bun 1.4.5 installed"
}

PLAY [Install Caddy Reverse Proxy] *********************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Install Caddy dependencies] **********************************************
changed: [$REDACTED$-signaling]

TASK [Add Caddy GPG key] *******************************************************
ok: [$REDACTED$-signaling]

TASK [Add Caddy repository] ****************************************************
ok: [$REDACTED$-signaling]

TASK [Install Caddy] ***********************************************************
changed: [$REDACTED$-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
changed: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Deploy Caddyfile] ********************************************************
changed: [$REDACTED$-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Enable Caddy] ************************************************************
ok: [$REDACTED$-signaling]

RUNNING HANDLER [Reload Caddy] *************************************************
changed: [$REDACTED$-signaling]

PLAY [Deploy Signaling Server Code] ********************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Create application directory] ********************************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
changed: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
changed: [$REDACTED$-signaling]

TASK [Deploy .env file] ********************************************************
changed: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Deploy systemd service files] ********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Check whether a server binary has been deployed yet] *********************
ok: [$REDACTED$-signaling]

TASK [Check for a deploy that left the binary and schema out of step] **********
ok: [$REDACTED$-signaling]

TASK [Read the interrupted deploy's recovery steps] ****************************
skipping: [$REDACTED$-signaling]

TASK [Refuse to start signaling services after an interrupted deploy] **********
skipping: [$REDACTED$-signaling]

TASK [Enable signaling services] ***********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Report that the binary is not deployed yet] ******************************
ok: [$REDACTED$-signaling] => {
    "msg": "No binary at /home/$REDACTED$/server/$REDACTED$-server, so the signaling units are enabled but not started. Run deploy/deploy.sh to build and ship it; that playbook starts and health-checks them."
}

TASK [Start signaling services] ************************************************
skipping: [$REDACTED$-signaling] => (item=3001)
skipping: [$REDACTED$-signaling]

TASK [Wait for each instance to accept connections] ****************************
skipping: [$REDACTED$-signaling] => (item=3001)
skipping: [$REDACTED$-signaling]

TASK [Deployment complete] *****************************************************
[ERROR]: Task failed: Finalization of task args for 'ansible.builtin.debug' failed: Error while resolving value for 'msg': 'git_commit' is undefined

Task failed.
Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/initial-setup.yml:356:7

354               {{ signaling_failure.stdout | default('no output captured') }}
355
356     - name: Deployment complete
          ^ column 7

<<< caused by >>>

Finalization of task args for 'ansible.builtin.debug' failed.
Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/initial-setup.yml:357:7

355
356     - name: Deployment complete
357       debug:
          ^ column 7

<<< caused by >>>

Error while resolving value for 'msg': 'git_commit' is undefined
Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/initial-setup.yml:358:14

356     - name: Deployment complete
357       debug:
358         msg: |
                 ^ column 14

fatal: [$REDACTED$-signaling]: FAILED! => {"msg": "Task failed: Finalization of task args for 'ansible.builtin.debug' failed: Error while resolving value for 'msg': 'git_commit' is undefined"}

PLAY RECAP *********************************************************************
$REDACTED$-coturn             : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
$REDACTED$-postgres           : ok=67   changed=14   unreachable=0    failed=0    skipped=6    rescued=0    ignored=0
$REDACTED$-signaling          : ok=40   changed=12   unreachable=0    failed=1    skipped=6    rescued=0    ignored=0

```

State of the VM after site.yml:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=inactive restarts=0

## binaries
/home/p2party/server/p2party-server: absent
/home/p2party/server/release-staging/p2party-server: absent
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: absent

## migration history (_prisma_migrations)
ERROR:  relation "_prisma_migrations" does not exist
LINE 1: ...count AS steps, logs IS NOT NULL AS has_logs FROM "_prisma_m...
                                                             ^

## schema details
Peer.socketGeneration: 0 column(s); PendingSignal.kind: 0 column(s); PendingSignal_createdAt_idx: 0 index(es)

## rows
ERROR:  relation "Peer" does not exist
LINE 1: SELECT (SELECT count(*) FROM "Peer") AS peers, (SELECT count...
                                     ^

## serving
worker 127.0.0.1:3001/health: no answer
Caddy https://signaling.rehearsal.localhost/health: no answer
signaling processes:
caddy: active
postgresql: active
```

Stand-in `trust-caddy-ca` (exit 0):

```text
rehash: warning: skipping ca-certificates.crt,it does not contain exactly one certificate or CRL
subject=CN = Caddy Local Authority - 2026 ECC Root
sha256 Fingerprint=A5:CA:AA:79:FA:F4:6C:6E:53:52:F7:3C:F8:35:CA:D0:12:56:9D:58:A4:7F:69:8E:C7:DC:C2:7C:EC:2E:52:19
```

## deploy.yml

deploy.yml (exit 0):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Build the binary and check its build record on this machine] *************

TASK [Build the Linux binary from this repo] ***********************************
changed: [p2party-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [p2party-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [p2party-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [p2party-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
ok: [p2party-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [p2party-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
ok: [p2party-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Require the pinned Bun on the signaling hosts] ***************************

TASK [Read the Bun version of the signaling host] ******************************
ok: [p2party-signaling]

TASK [Read the signaling host's architecture] **********************************
ok: [p2party-signaling]

TASK [Require Bun 1.4.5 on the signaling host] *********************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-postgres]

TASK [Install certificate tooling] *********************************************
ok: [p2party-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [p2party-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [p2party-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [p2party-postgres]

TASK [Create the database server key and signing request] **********************
ok: [p2party-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [p2party-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [p2party-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [p2party-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [p2party-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [p2party-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [p2party-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [p2party-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [p2party-postgres] => (item=ca.key)
ok: [p2party-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [p2party-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [p2party-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [p2party-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [p2party-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [p2party-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [p2party-signaling]

PLAY [Deploy $REDACTED$ signaling server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
ok: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
ok: [$REDACTED$-signaling]

TASK [Ensure the server directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
changed: [$REDACTED$-signaling]

TASK [Copy the audited package manifest and frozen dependency lock] ************
changed: [$REDACTED$-signaling] => (item=package.json)
changed: [$REDACTED$-signaling] => (item=bun.lock)

TASK [Install exactly the audited migration dependencies] **********************
changed: [$REDACTED$-signaling]

TASK [Ensure the prisma directory exists] **************************************
changed: [$REDACTED$-signaling]

TASK [Copy the schema] *********************************************************
changed: [$REDACTED$-signaling]

TASK [Copy the migrations] *****************************************************
changed: [$REDACTED$-signaling]

TASK [Copy the Prisma config] **************************************************
changed: [$REDACTED$-signaling]

TASK [Ensure the release staging directory exists] *****************************
changed: [$REDACTED$-signaling]

TASK [Stage the compiled binary] ***********************************************
changed: [$REDACTED$-signaling]

TASK [Read the staged binary's SHA-256] ****************************************
ok: [$REDACTED$-signaling]

TASK [Require the staged binary to be the one built] ***************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Stage the signaling environment file] ************************************
changed: [$REDACTED$-signaling]

TASK [Stage the systemd unit files] ********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Render the candidate Caddy configuration] ********************************
changed: [$REDACTED$-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Validate the candidate Caddy configuration] ******************************
ok: [$REDACTED$-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Discover the signaling units to stop before migrating] *******************
ok: [$REDACTED$-signaling]

TASK [Stop and disable every signaling worker before migrating] ****************
changed: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged binary] ***********************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged signaling environment file] ***************************
ok: [$REDACTED$-signaling]

TASK [Install the staged systemd unit files] ***********************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Remove the marker now that the binary matches the schema] ****************
changed: [$REDACTED$-signaling]

TASK [Atomically install the validated Caddy configuration] ********************
changed: [$REDACTED$-signaling]

TASK [Reload Caddy onto the desired signaling ports] ***************************
changed: [$REDACTED$-signaling]

TASK [Restart signaling services] **********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Wait for each instance to accept connections] ****************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Read health from every signaling instance] *******************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Verify every signaling instance reports the expected build] **************
ok: [$REDACTED$-signaling] => (item=3001) => {
    "ansible_loop_var": "item",
    "changed": false,
    "item": {
        "ansible_loop_var": "item",
        "ansible_parsed": true,
        "cache_control": "no-store",
        "changed": false,
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"726d1d42-3f9a-482f-98e4-f4003a4a486f\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:50:09 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "726d1d42-3f9a-482f-98e4-f4003a4a486f",
            "status": "ok",
            "version": "0.1.4"
        },
        "msg": "OK (103 bytes)",
        "redirected": false,
        "status": 200,
        "url": "http://127.0.0.1:3001/health"
    },
    "msg": "All assertions passed"
}

TASK [Collect signaling instance identifiers] **********************************
ok: [$REDACTED$-signaling]

TASK [Verify every signaling port belongs to a distinct process] ***************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Build the desired signaling unit path list] ******************************
ok: [$REDACTED$-signaling]

TASK [Discover installed signaling unit files] *********************************
ok: [$REDACTED$-signaling]

TASK [Resolve obsolete signaling unit files] ***********************************
ok: [$REDACTED$-signaling]

TASK [Stop and disable obsolete signaling services] ****************************
skipping: [$REDACTED$-signaling]

TASK [Remove obsolete signaling unit files] ************************************
skipping: [$REDACTED$-signaling]

TASK [Reload systemd after retiring obsolete signaling services] ***************
skipping: [$REDACTED$-signaling]

TASK [Read public signaling health through Caddy] ******************************
ok: [$REDACTED$-signaling]

TASK [Verify Caddy exposes only the expected signaling build] ******************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Deployment complete] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "$REDACTED$ signaling server 0.1.4 deployed to $REDACTED$-signaling on 1 verified workers"
}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=61   changed=21   unreachable=0    failed=0    skipped=3    rescued=0    ignored=0

```

State of the VM after deploy.yml:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: absent

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | t | f | 1 | f
(5 rows)

## schema details
Peer.socketGeneration: 1 column(s); PendingSignal.kind: 1 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
0 | 0 | 0 | 0 | 0
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"726d1d42-3f9a-482f-98e4-f4003a4a486f"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"726d1d42-3f9a-482f-98e4-f4003a4a486f"}
signaling processes: 9886 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

## initial-setup.yml again, with a binary deployed

initial-setup.yml (exit 2):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-postgres]

TASK [Install certificate tooling] *********************************************
ok: [p2party-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [p2party-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [p2party-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [p2party-postgres]

TASK [Create the database server key and signing request] **********************
ok: [p2party-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [p2party-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [p2party-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [p2party-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [p2party-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [p2party-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [p2party-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [p2party-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [p2party-postgres] => (item=ca.key)
ok: [p2party-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [p2party-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [p2party-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [p2party-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [p2party-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [p2party-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [p2party-signaling]

PLAY [Pre-flight checks] *******************************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Verify SSH connectivity] *************************************************
ok: [p2party-signaling]

TASK [Display target info] *****************************************************
ok: [p2party-signaling] => {
    "msg": "Setting up signaling server on p2party-signaling (127.0.0.1)"
}

PLAY [Install Bun on Signaling Server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Check if Bun is installed] ***********************************************
ok: [p2party-signaling]

TASK [Install unzip (required for Bun)] ****************************************
skipping: [p2party-signaling]

TASK [Install Bun via official installer] **************************************
skipping: [p2party-signaling]

TASK [Verify Bun installation] *************************************************
ok: [p2party-signaling]

TASK [Display Bun version] *****************************************************
ok: [p2party-signaling] => {
    "msg": "Bun 1.4.5 installed"
}

PLAY [Install Caddy Reverse Proxy] *********************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Install Caddy dependencies] **********************************************
ok: [p2party-signaling]

TASK [Add Caddy GPG key] *******************************************************
ok: [p2party-signaling]

TASK [Add Caddy repository] ****************************************************
ok: [p2party-signaling]

TASK [Install Caddy] ***********************************************************
ok: [p2party-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [p2party-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
ok: [p2party-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Deploy Caddyfile] ********************************************************
ok: [p2party-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [p2party-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Enable Caddy] ************************************************************
ok: [p2party-signaling]

PLAY [Deploy Signaling Server Code] ********************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Create application directory] ********************************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
ok: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
ok: [$REDACTED$-signaling]

TASK [Deploy .env file] ********************************************************
ok: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Deploy systemd service files] ********************************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Check whether a server binary has been deployed yet] *********************
ok: [$REDACTED$-signaling]

TASK [Check for a deploy that left the binary and schema out of step] **********
ok: [$REDACTED$-signaling]

TASK [Read the interrupted deploy's recovery steps] ****************************
skipping: [$REDACTED$-signaling]

TASK [Refuse to start signaling services after an interrupted deploy] **********
skipping: [$REDACTED$-signaling]

TASK [Enable signaling services] ***********************************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Report that the binary is not deployed yet] ******************************
skipping: [$REDACTED$-signaling]

TASK [Start signaling services] ************************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Wait for each instance to accept connections] ****************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Deployment complete] *****************************************************
[ERROR]: Task failed: Finalization of task args for 'ansible.builtin.debug' failed: Error while resolving value for 'msg': 'git_commit' is undefined

Task failed.
Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/initial-setup.yml:356:7

354               {{ signaling_failure.stdout | default('no output captured') }}
355
356     - name: Deployment complete
          ^ column 7

<<< caused by >>>

Finalization of task args for 'ansible.builtin.debug' failed.
Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/initial-setup.yml:357:7

355
356     - name: Deployment complete
357       debug:
          ^ column 7

<<< caused by >>>

Error while resolving value for 'msg': 'git_commit' is undefined
Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/initial-setup.yml:358:14

356     - name: Deployment complete
357       debug:
358         msg: |
                 ^ column 14

fatal: [$REDACTED$-signaling]: FAILED! => {"msg": "Task failed: Finalization of task args for 'ansible.builtin.debug' failed: Error while resolving value for 'msg': 'git_commit' is undefined"}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=33   changed=1    unreachable=0    failed=1    skipped=5    rescued=0    ignored=0

```

State of the VM after initial-setup.yml:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: absent

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | t | f | 1 | f
(5 rows)

## schema details
Peer.socketGeneration: 1 column(s); PendingSignal.kind: 1 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
0 | 0 | 0 | 0 | 0
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"2c1b975e-0cbe-45e1-895a-d647e0229da1"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"2c1b975e-0cbe-45e1-895a-d647e0229da1"}
signaling processes: 11380 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

## setup-coturn.yml (Caddy already holds 443 on this VM)

setup-coturn.yml (exit 2):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Setup Coturn TURN/STUN Server] *******************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-coturn]

TASK [Require finite TURN bandwidth budgets] ***********************************
ok: [$REDACTED$-coturn] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Display setup info] ******************************************************
ok: [$REDACTED$-coturn] => {
    "msg": "Configuring Coturn on $REDACTED$-coturn (127.0.0.1)"
}

TASK [Ensure coturn is installed] **********************************************
changed: [$REDACTED$-coturn]

TASK [Enable coturn service] ***************************************************
changed: [$REDACTED$-coturn]

TASK [Stop coturn for certbot standalone] **************************************
changed: [$REDACTED$-coturn]

TASK [Check if certificate exists] *********************************************
ok: [$REDACTED$-coturn]

TASK [Obtain Let's Encrypt certificate] ****************************************
skipping: [$REDACTED$-coturn]

TASK [Create certbot renewal hook for coturn] **********************************
changed: [$REDACTED$-coturn]

TASK [Create coturn cert directory] ********************************************
changed: [$REDACTED$-coturn]

TASK [Copy certificate for coturn] *********************************************
changed: [$REDACTED$-coturn]

TASK [Copy private key for coturn] *********************************************
changed: [$REDACTED$-coturn]

TASK [Read the effective coturn unit] ******************************************
ok: [$REDACTED$-coturn]

TASK [Read /etc/default/coturn] ************************************************
ok: [$REDACTED$-coturn]

TASK [Refuse coturn command-line flags that override turnserver.conf] **********
ok: [$REDACTED$-coturn] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Render the candidate coturn configuration] *******************************
changed: [$REDACTED$-coturn]

TASK [Read the candidate coturn configuration] *********************************
ok: [$REDACTED$-coturn]

TASK [Validate the candidate coturn configuration] *****************************
ok: [$REDACTED$-coturn]

TASK [Install the validated coturn configuration] ******************************
changed: [$REDACTED$-coturn]

TASK [Remove the coturn configuration candidate] *******************************
changed: [$REDACTED$-coturn]

TASK [Remove the coturn file log and its rotation] *****************************
ok: [$REDACTED$-coturn] => (item=/etc/logrotate.d/coturn)
ok: [$REDACTED$-coturn] => (item=/var/log/turnserver)

TASK [Enable and start coturn] *************************************************
[ERROR]: Task failed: Module failed: Unable to start service coturn: Job for coturn.service failed because the control process exited with error code.
See "systemctl status coturn.service" and "journalctl -xeu coturn.service" for details.

Origin: <work>/trees/f6802bd7f7f4/deploy/ansible/playbooks/setup-coturn.yml:238:7

236         - /var/log/turnserver
237
238     - name: Enable and start coturn
          ^ column 7

fatal: [$REDACTED$-coturn]: FAILED! => {"changed": false, "msg": "Unable to start service coturn: Job for coturn.service failed because the control process exited with error code.\nSee \"systemctl status coturn.service\" and \"journalctl -xeu coturn.service\" for details.\n"}

PLAY RECAP *********************************************************************
$REDACTED$-coturn             : ok=20   changed=10   unreachable=0    failed=1    skipped=1    rescued=0    ignored=0
$REDACTED$-postgres           : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

```

coturn after setup-coturn.yml (unit state; listeners on 443 and 3478):

```text
activating
tcp *:443 users:(("caddy",pid=7447,fd=9))
udp *:443 users:(("caddy",pid=7447,fd=10))
```

- Finished: 2026-11-26T23:51:52Z
