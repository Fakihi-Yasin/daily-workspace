#!/usr/bin/env bash
# Daily Workspace — install the PC Work Time agent on macOS (current user, no sudo).
#   curl -fsSL https://<your-dashboard>/pc-agent/install-macos.sh | bash -s -- <CODE>
# Needs python3: macOS offers to install the Command Line Tools the first time you run `python3`.
set -euo pipefail
CODE="${1:-}"
DIR="$HOME/Library/Application Support/Daily Workspace PC Time"
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || die "this installer is for macOS."
python3 -c 'import sys; assert sys.version_info >= (3, 9)' 2>/dev/null || die "python3 (3.9+) is missing. Run: xcode-select --install   (or install Python from python.org), then try again."
[ -n "$CODE" ] || { read -r -p "Paste the code from Settings → PC Work Time: " CODE < /dev/tty; }
ORIGIN="$(python3 -c 'import base64,json,sys; c=sys.argv[1]; print(json.loads(base64.urlsafe_b64decode(c+"="*(-len(c)%4))).get("o",""))' "$CODE" 2>/dev/null || true)"
[[ "$ORIGIN" == https://* ]] || die "that code is not valid. Copy it again from Settings → PC Work Time."
mkdir -p "$DIR"
curl -fsSL "$ORIGIN/pc-agent/dw-pc-time.py" -o "$DIR/dw-pc-time.py"
python3 -m py_compile "$DIR/dw-pc-time.py" || die "the downloaded agent is damaged; try again."
python3 "$DIR/dw-pc-time.py" pair "$CODE"
python3 "$DIR/dw-pc-time.py" autostart on      # LaunchAgent: starts at login and now
mkdir -p "$HOME/.local/bin" && ln -sf "$DIR/dw-pc-time.py" "$HOME/.local/bin/dw-pc-time" && chmod 755 "$DIR/dw-pc-time.py"
echo "Done. PC Work Time starts at login. Commands: ~/.local/bin/dw-pc-time status | pause | resume | open"
