#!/usr/bin/env bash
# Build the full upstream suite with Ubuntu's service account, unit, file
# ownership and package dependencies. Only mmdebstrap and the downloader run
# on the builder host. All compilers and database clients stay in the chroot.
set -euo pipefail
target_dir=${1:?usage: build-deb.sh OUTPUT_DIRECTORY [amd64|arm64]}
arch=${2:-$(dpkg --print-architecture)}
case "$arch" in
  amd64) mirror=https://archive.ubuntu.com/ubuntu; security=https://security.ubuntu.com/ubuntu ;;
  arm64) mirror=https://ports.ubuntu.com/ubuntu-ports; security=$mirror ;;
  *) echo "Unsupported coturn build architecture" >&2; exit 1 ;;
esac
version=4.19.2
revision=1p2party1~noble1
commit=32d62f3be6180bd9e870e5d5bb4c047075b4627c
upstream_sha=a1c895fc6fbf1a50c533437f8745de1ec145125233036a7e4391edbdc7d87022
packaging_sha=cb8fcbf7d45bdc0a99cd7bb6f87b9f220739af2b7a048a3e7460e95b562d328b
name="coturn_${version}-${revision}_${arch}.deb"
test "$(id -u)" = 0 || { echo 'Building the disposable chroot requires root' >&2; exit 1; }
install -d -m 0755 "$target_dir"
exec 9>"$target_dir/.build.lock"
flock 9
if (cd "$target_dir" && test -f "$name.sha256" && sha256sum --status --check "$name.sha256"); then exit 0; fi
work=$(mktemp -d /var/tmp/p2party-coturn.XXXXXXXX)
trap 'rm -rf --one-file-system -- "$work"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  "https://codeload.github.com/coturn/coturn/tar.gz/$commit" -o "$work/upstream.tgz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://archive.ubuntu.com/ubuntu/pool/universe/c/coturn/coturn_4.6.1-1build4.debian.tar.xz -o "$work/packaging.txz"
(cd "$work" && printf '%s  %s\n' "$upstream_sha" upstream.tgz "$packaging_sha" packaging.txz | sha256sum --check --strict)
deps=build-essential,ca-certificates,debhelper,fakeroot,default-libmysqlclient-dev,default-mysql-client,libsystemd-dev,pkg-config,libevent-dev,libhiredis-dev,libpq-dev,libsqlite3-dev,libssl-dev,postgresql-client,sqlite3
mmdebstrap --keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg --mode=root --architectures="$arch" --variant=buildd --include="$deps" noble "$work/root" \
  "deb $mirror noble main universe" "deb $mirror noble-updates main universe" \
  "deb $security noble-security main universe"
src="$work/root/build/source"
mkdir -p "$src"
tar -xzf "$work/upstream.tgz" --no-same-owner --strip-components=1 -C "$src"
tar -xJf "$work/packaging.txz" --no-same-owner -C "$src"
# Noble's two patches for obsolete OpenSSL code apply only to 4.6.1.
# The newer upstream code handles OpenSSL 3; retain Noble's default logging
# patch. The service deploy supplies the project's managed configuration.
printf '%s\n' Set-logging-to-syslog.patch > "$src/debian/patches/series"
{
  printf 'coturn (%s-%s) noble; urgency=medium\n\n' "$version" "$revision"
  printf '  * Build upstream %s for the P2Party TURN service.\n\n' "$commit"
  printf ' -- P2Party contributors <security@p2party.com>  Fri, 27 Nov 2026 00:00:00 +0000\n\n'
  cat "$src/debian/changelog"
} > "$work/changelog"
cp "$work/changelog" "$src/debian/changelog"
# buildd includes base-passwd's nobody account. Drop privileges before executing
# upstream build code without depending on host account-management utilities.
chroot "$work/root" chown -R 65534:65534 /build
chroot --userspec=65534:65534 "$work/root" /usr/bin/env HOME=/build sh -ec 'cd /build/source && DEB_BUILD_OPTIONS="parallel=2" dpkg-buildpackage -b -us -uc'
file="$work/root/build/$name"
test "$(dpkg-deb -f "$file" Package)" = coturn
test "$(dpkg-deb -f "$file" Version)" = "$version-$revision"
test "$(dpkg-deb -f "$file" Architecture)" = "$arch"
# Rename only after the full native package and upstream protocol test pass.
install -m 0644 "$file" "$target_dir/.$name.new"
mv -- "$target_dir/.$name.new" "$target_dir/$name"
(cd "$target_dir" && sha256sum "$name" > "$name.sha256")
