#!/bin/bash
# Build the Jarvis Cinnamon add-ons as .deb packages.
#
# Copies each add-on from this repo into a package that installs under
# /usr/share/cinnamon/.
#
#   packaging/build.sh            build both packages into packaging/dist
#   packaging/build.sh drawer     build only the drawer
#   packaging/build.sh monitor    build only the monitor
#
# Install:  sudo apt-get install -y --reinstall ./packaging/dist/<package>.deb
# Version is "<metadata version>+<timestamp>", so every rebuild is an upgrade.
set -euo pipefail
cd "$(dirname "$0")"

REPO=$(cd .. && pwd)
DRAWER_SRC=$REPO/drawer/jarvis-drawer@harish
MONITOR_SRC=$REPO/monitor/jarvis-monitor@harish
STAMP=$(date +%Y%m%d%H%M)

build() {   # name kind(applets|desklets) src description
    local name=$1 kind=$2 src=$3 desc=$4
    local uuid; uuid=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]+'/metadata.json'))['uuid'])" "$src")
    local mver; mver=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]+'/metadata.json')).get('version','1.0'))" "$src")
    local ver="${mver}+${STAMP}"
    local root; root=$(mktemp -d)
    local dest="$root/usr/share/cinnamon/$kind/$uuid"
    mkdir -p "$dest" "$root/DEBIAN"
    # source files only: no backups, editor leftovers or caches
    (cd "$src" && tar cf - --exclude='*.bak' --exclude='*~' --exclude='*.swp' --exclude=__pycache__ .) | (cd "$dest" && tar xf -)
    find "$root" -type d -exec chmod 755 {} +
    find "$dest" -type f -exec chmod 644 {} +
    cat > "$root/DEBIAN/control" <<CTL
Package: $name
Version: $ver
Section: gnome
Priority: optional
Architecture: all
Depends: cinnamon (>= 6.0)
Maintainer: K-S-Harish-Balagi <85448207+K-S-Harish-Balagi@users.noreply.github.com>
Description: $desc
 Installs $uuid under /usr/share/cinnamon/$kind so it loads from the main
 partition.
CTL
    mkdir -p dist
    dpkg-deb --root-owner-group --build "$root" "dist/${name}_${ver}_all.deb" >/dev/null
    rm -rf "$root"
    echo "built dist/${name}_${ver}_all.deb"
}

which=${1:-all}
[ "$which" = all ] || [ "$which" = drawer ]  && build jarvis-drawer-applet  applets "$DRAWER_SRC"  "Jarvis Drawer - full-screen app launcher applet for Cinnamon"
[ "$which" = all ] || [ "$which" = monitor ] && build jarvis-monitor-desklet desklets "$MONITOR_SRC" "Jarvis Monitor - HUD system monitor desklet for Cinnamon"
true
