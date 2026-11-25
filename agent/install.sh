#!/usr/bin/env bash
# Daily Workspace — install the PC Work Time agent for the current user (Ubuntu 24.04, GNOME).
#   curl -fsSL https://<your-dashboard>/pc-agent/install.sh | bash -s -- <CODE>
# <CODE> comes from Settings → PC Work Time → Connect this PC. No sudo needed: everything goes into
# your home folder, and the agent starts with your desktop session (systemd user service).
set -euo pipefail

CODE="${1:-}"
APP=daily-workspace-pc-time
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/$APP"
BIN="$HOME/.local/bin"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not with sudo."
command -v python3 >/dev/null || die "python3 is missing (sudo apt install python3)."
command -v gdbus >/dev/null || die "gdbus is missing (sudo apt install libglib2.0-bin)."
command -v systemctl >/dev/null || die "systemd is required."
[ -n "$CODE" ] || { read -r -p "Paste the code from Settings → PC Work Time: " CODE < /dev/tty; }
[ -n "$CODE" ] || die "no code given."

# Where to download the agent from: the dashboard that issued the code.
ORIGIN="$(python3 -c 'import base64,json,sys; c=sys.argv[1]; print(json.loads(base64.urlsafe_b64decode(c+"="*(-len(c)%4))).get("o",""))' "$CODE" 2>/dev/null || true)"
[[ "$ORIGIN" == https://* || "$ORIGIN" == http://localhost:* ]] || die "that code is not valid. Copy it again from Settings → PC Work Time."

mkdir -p "$SHARE" "$BIN" "$UNIT_DIR" "$APPS"
if [ -n "${DW_AGENT_FILE:-}" ]; then cp "$DW_AGENT_FILE" "$SHARE/dw-pc-time.py"
else curl -fsSL "$ORIGIN/pc-agent/dw-pc-time.py" -o "$SHARE/dw-pc-time.py.new" && mv "$SHARE/dw-pc-time.py.new" "$SHARE/dw-pc-time.py"; fi
chmod 755 "$SHARE/dw-pc-time.py"
ln -sf "$SHARE/dw-pc-time.py" "$BIN/dw-pc-time"
python3 -m py_compile "$SHARE/dw-pc-time.py" || die "the downloaded agent is damaged; try again."

say "Connecting this computer…"
python3 "$SHARE/dw-pc-time.py" pair "$CODE"

cat > "$UNIT_DIR/$APP.service" <<UNIT
[Unit]
Description=Daily Workspace — PC Work Time (counts active time; sends one total per day)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=/usr/bin/env python3 $SHARE/dw-pc-time.py run
Restart=on-failure
RestartSec=20

[Install]
WantedBy=graphical-session.target
UNIT

cat > "$APPS/$APP.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=PC Work Time
Comment=Daily Workspace: show today's PC Work Time
Exec=$SHARE/dw-pc-time.py notify
Icon=appointment-soon
Terminal=false
Categories=Utility;
Actions=pause;resume;details;

[Desktop Action pause]
Name=Pause
Exec=$SHARE/dw-pc-time.py pause

[Desktop Action resume]
Name=Resume
Exec=$SHARE/dw-pc-time.py resume

[Desktop Action details]
Name=Activity Details (this computer)
Exec=$SHARE/dw-pc-time.py open
DESK

systemctl --user daemon-reload
systemctl --user enable --now "$APP.service"
say "Done. PC Work Time now starts with your session."
echo "  Pause / Resume: right-click “PC Work Time” in the app grid or dock, or run: dw-pc-time pause | resume"
echo "  Status: dw-pc-time status     Remove: curl -fsSL $ORIGIN/pc-agent/uninstall.sh | bash"
