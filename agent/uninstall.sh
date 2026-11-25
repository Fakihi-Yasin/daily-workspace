#!/usr/bin/env bash
# Daily Workspace — remove the PC Work Time agent from this computer (your recorded days stay in the
# account; disconnect the computer in Settings → PC Work Time to also revoke its key).
set -uo pipefail
APP=daily-workspace-pc-time
systemctl --user disable --now "$APP.service" 2>/dev/null
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$APP.service" "$HOME/.local/bin/dw-pc-time" \
      "${XDG_DATA_HOME:-$HOME/.local/share}/applications/$APP.desktop"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/$APP" "${XDG_CONFIG_HOME:-$HOME/.config}/$APP" \
       "${XDG_STATE_HOME:-$HOME/.local/state}/$APP"
systemctl --user daemon-reload 2>/dev/null
echo "PC Work Time agent removed."
