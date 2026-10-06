#!/usr/bin/env bash
# Linux Printing Support installer.
#   ./install.sh            install system printing pieces + the app
#   ./install.sh --app-only skip the system packages (no sudo needed)
#   ./install.sh --uninstall
set -euo pipefail

APP=linux-printing-support
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

if [[ "${1:-}" == "--uninstall" ]]; then
  step "Removing app"
  uv tool uninstall "$APP" 2>/dev/null || true
  rm -f "$DATA/applications/$APP.desktop" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
  rm -rf "$DATA/$APP"
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  bold "Uninstalled. (CUPS and ipp-usb were left in place.)"
  exit 0
fi

if [[ "${1:-}" != "--app-only" ]]; then
  # CUPS = the print system, ipp-usb = driverless printing for USB printers,
  # avahi/nss-mdns = finding network printers, LibreOffice = printing Office files.
  step "Installing printing support (needs your password)"
  if command -v pacman >/dev/null; then
    sudo pacman -S --needed --noconfirm cups cups-filters ipp-usb avahi nss-mdns polkit ghostscript
    command -v soffice >/dev/null || sudo pacman -S --needed --noconfirm libreoffice-fresh || true
  elif command -v apt-get >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y cups cups-filters ipp-usb avahi-daemon libnss-mdns policykit-1 ghostscript || \
      sudo apt-get install -y cups cups-filters ipp-usb avahi-daemon libnss-mdns pkexec ghostscript
    command -v soffice >/dev/null || sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress || true
  elif command -v dnf >/dev/null; then
    sudo dnf install -y cups cups-filters ipp-usb avahi nss-mdns polkit ghostscript
    command -v soffice >/dev/null || sudo dnf install -y libreoffice-writer libreoffice-calc libreoffice-impress || true
  elif command -v zypper >/dev/null; then
    sudo zypper install -y cups cups-filters ipp-usb avahi nss-mdns polkit ghostscript
    command -v soffice >/dev/null || sudo zypper install -y libreoffice-writer libreoffice-calc libreoffice-impress || true
  else
    echo "Unknown package manager. Install these yourself: cups, cups-filters, ipp-usb, avahi, nss-mdns, polkit, libreoffice"
  fi

  step "Starting printing services"
  sudo systemctl enable --now cups.service 2>/dev/null || sudo systemctl enable --now cups.socket || true
  sudo systemctl enable --now avahi-daemon.service 2>/dev/null || true
  sudo systemctl enable --now ipp-usb.service 2>/dev/null || true

  # A legacy usb:// queue and ipp-usb fight over the same USB port; the old queue
  # then hangs forever. Point the user at it rather than deleting their queues.
  if lpstat -v 2>/dev/null | grep -q " usb://"; then
    bold "Heads up: you have printers set up through the old USB method:"
    lpstat -v | grep " usb://" | sed 's/^/   /'
    echo "   These often hang with 'driverless' printers. Remove them with: sudo lpadmin -x NAME"
    echo "   then add the printer again from inside the app (Printer menu → Add a printer)."
  fi
fi

step "Installing the app"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
uv tool install --force --reinstall "$HERE"

step "Adding it to your app launcher"
install -Dm644 "$HERE/src/linux_printing_support/static/icon.svg" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
BIN="$(realpath -ms "$(uv tool dir --bin 2>/dev/null || echo "$HOME/.local/bin")/$APP")"
mkdir -p "$DATA/applications"
sed "s|@BIN@|$BIN|" "$HERE/$APP.desktop" > "$DATA/applications/$APP.desktop"
update-desktop-database "$DATA/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" 2>/dev/null || true

bold "Done! Open \"Linux Printing Support\" from your apps, or right-click a file → Open with."
