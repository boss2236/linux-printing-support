#!/usr/bin/env bash
# Linux Printing Support installer — works on Arch, Debian/Ubuntu, Fedora and openSUSE.
#
#   curl -fsSL https://raw.githubusercontent.com/boss2236/linux-printing-support/main/install.sh | bash
#
# Options (after `bash -s --` when piping):
#   --app-only     skip system packages (CUPS, ipp-usb, …); no password needed
#   --no-office    don't offer LibreOffice (only needed for Word/Excel/PowerPoint files)
#   --yes          answer yes to every question
#   --uninstall    remove the app (leaves CUPS and printers alone)
set -euo pipefail

APP=linux-printing-support
REPO="${LPS_REPO:-boss2236/linux-printing-support}"
BRANCH="${LPS_BRANCH:-main}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
HOME_DIR="$DATA/$APP"

APP_ONLY=0 NO_OFFICE=0 YES=0 UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --app-only) APP_ONLY=1 ;;
    --no-office) NO_OFFICE=1 ;;
    --yes|-y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then B=$'\033[1m' P=$'\033[1;35m' G=$'\033[1;32m' Y=$'\033[1;33m' R=$'\033[0m'; else B= P= G= Y= R=; fi
step() { printf '%s==>%s %s\n' "$P" "$R" "$*"; }
note() { printf '%s!%s  %s\n' "$Y" "$R" "$*"; }
die()  { printf '%sError:%s %s\n' "$Y" "$R" "$*" >&2; exit 1; }
# Questions read from the terminal even when this script arrives through a pipe.
ask() {
  [[ $YES == 1 ]] && return 0
  [[ -r /dev/tty ]] || return 1
  local reply
  printf '%s?%s  %s [Y/n] ' "$P" "$R" "$1" > /dev/tty
  read -r reply < /dev/tty || return 1
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# ------------------------------------------------------------------ uninstall
if [[ $UNINSTALL == 1 ]]; then
  step "Removing Linux Printing Support"
  command -v uv >/dev/null && uv tool uninstall "$APP" >/dev/null 2>&1 || true
  rm -f "$DATA/applications/$APP.desktop" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
  rm -rf "$HOME_DIR"
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  printf '%sUninstalled.%s CUPS, ipp-usb and your printers were left as they are.\n' "$G" "$R"
  exit 0
fi

[[ $EUID == 0 ]] && die "run this as your normal user, not root (it asks for your password when needed)."

# ------------------------------------------------------------------ get the source
# Running from a checkout uses it as is; piped from curl, download the latest release tarball.
SELF="${BASH_SOURCE[0]:-}"
if [[ -n "$SELF" && -f "$(dirname "$SELF")/pyproject.toml" ]]; then
  SRC="$(cd "$(dirname "$SELF")" && pwd)"
else
  command -v curl >/dev/null || die "curl is needed to download the app."
  step "Downloading Linux Printing Support"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$tmp" \
    || die "download failed — check your internet connection."
  mkdir -p "$HOME_DIR"
  rm -rf "$HOME_DIR/app"
  mv "$tmp"/*/ "$HOME_DIR/app"
  SRC="$HOME_DIR/app"
fi

# ------------------------------------------------------------------ system pieces
need_sudo() { command -v sudo >/dev/null || die "sudo is needed to install system packages (or use --app-only)."; }
if [[ $APP_ONLY == 0 ]]; then
  # cups = the print system · ipp-usb = USB printers without drivers · avahi + nss-mdns =
  # finding network printers · polkit = password prompts from the app (add printer, fix).
  step "Installing printing support (asks for your password)"
  need_sudo
  office=0
  if [[ $NO_OFFICE == 0 ]] && ! command -v soffice >/dev/null; then
    ask "Also install LibreOffice so you can print Word, Excel and PowerPoint files? (~350 MB)" && office=1
  fi
  if command -v pacman >/dev/null; then
    sudo pacman -S --needed --noconfirm cups cups-filters ipp-usb avahi nss-mdns polkit ghostscript
    [[ $office == 1 ]] && sudo pacman -S --needed --noconfirm libreoffice-fresh
  elif command -v apt-get >/dev/null; then
    sudo apt-get update -qq
    pk=pkexec; apt-cache show pkexec >/dev/null 2>&1 || pk=policykit-1
    sudo apt-get install -y cups cups-filters ipp-usb avahi-daemon libnss-mdns "$pk" ghostscript
    [[ $office == 1 ]] && sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress
  elif command -v dnf >/dev/null; then
    sudo dnf install -y cups cups-filters ipp-usb avahi nss-mdns polkit ghostscript
    [[ $office == 1 ]] && sudo dnf install -y libreoffice-writer libreoffice-calc libreoffice-impress
  elif command -v zypper >/dev/null; then
    sudo zypper --non-interactive install cups cups-filters ipp-usb avahi nss-mdns polkit ghostscript
    [[ $office == 1 ]] && sudo zypper --non-interactive install libreoffice-writer libreoffice-calc libreoffice-impress
  else
    note "Unknown package manager. Please install: cups, cups-filters, ipp-usb, avahi, nss-mdns, polkit."
  fi

  step "Starting printing services"
  sudo systemctl enable --now cups.service 2>/dev/null || sudo systemctl enable --now cups.socket 2>/dev/null || true
  sudo systemctl enable --now avahi-daemon.service 2>/dev/null || true
  sudo systemctl enable --now ipp-usb.service 2>/dev/null || true

  # Old-style usb:// queues and ipp-usb fight over the same USB port, and the old queue
  # then "prints" forever while nothing comes out. Point them out; don't delete them.
  if lpstat -v 2>/dev/null | grep -q " usb://"; then
    note "These printers use the old USB method, which often hangs with modern printers:"
    lpstat -v | grep " usb://" | sed 's/^/     /'
    echo "     Remove them with:  sudo lpadmin -x NAME"
    echo "     then add the printer again in the app (printer menu → Add a printer)."
  fi
fi

# ------------------------------------------------------------------ the app
step "Installing the app"
if ! command -v uv >/dev/null; then
  if [[ -x "$HOME/.local/bin/uv" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
# uv brings its own Python if the system one is too old, so this works on older distros too.
uv tool install --force --reinstall --quiet "$SRC"

step "Adding it to your apps"
install -Dm644 "$SRC/src/linux_printing_support/static/icon.svg" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
BIN="$(realpath -ms "$(uv tool dir --bin 2>/dev/null || echo "$HOME/.local/bin")/$APP")"
mkdir -p "$DATA/applications"
sed "s|@BIN@|$BIN|" "$SRC/$APP.desktop" > "$DATA/applications/$APP.desktop"
update-desktop-database "$DATA/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" 2>/dev/null || true
# Keep a copy of this script so uninstalling works without the internet.
[[ "$SRC" == "$HOME_DIR/app" ]] || { mkdir -p "$HOME_DIR"; cp "$SRC/install.sh" "$HOME_DIR/install.sh"; }

browser=""
for b in chromium google-chrome-stable google-chrome brave brave-browser microsoft-edge-stable vivaldi-stable; do
  command -v "$b" >/dev/null && { browser=$b; break; }
done
[[ -z "$browser" ]] && note "No Chromium-based browser found, so the app will open as a tab in your default browser. Install Chromium for its own window."

printf '\n%sDone!%s Open %sLinux Printing Support%s from your apps, or right-click a file → Open with.\n' "$G" "$R" "$B" "$R"
case ":$PATH:" in *":$(dirname "$BIN"):"*) ;; *) note "To run it from a terminal, add $(dirname "$BIN") to your PATH." ;; esac
printf 'Update anytime by running the same install command again.\n'
