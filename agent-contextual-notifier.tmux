#!/usr/bin/env bash

set -u

[ -n "${TMUX:-}" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0

OPTION="@agent_waiting"
MARKER_SEGMENT='#{?@agent_waiting,#{@agent_waiting} ,}'

# Names used by opencode-contextual-notifier, migrated in place so existing
# configurations keep working after the rename.
LEGACY_OPTION="@opencode_waiting"
LEGACY_MARKER_OPTION="@opencode-notifier-marker"

MARKER="$(tmux show-option -gqv @agent-notifier-marker 2>/dev/null)"
if [ -z "$MARKER" ]; then
	MARKER="$(tmux show-option -gqv "$LEGACY_MARKER_OPTION" 2>/dev/null)"
	tmux set-option -gq @agent-notifier-marker "${MARKER:-●}"
fi

install_marker() {
	local option_name="$1"
	local current migrated
	current="$(tmux show-window-options -gv "$option_name" 2>/dev/null)"
	migrated=${current//"$LEGACY_OPTION"/$OPTION}
	case "$migrated" in
	*'#{@agent_waiting}'*) ;;
	*) migrated="${MARKER_SEGMENT}${migrated}" ;;
	esac
	[ "$migrated" = "$current" ] || tmux set-window-option -g "$option_name" "$migrated"
}

install_marker window-status-format
install_marker window-status-current-format

# Early versions rendered the marker in status-right; drop that segment.
STATUS_RIGHT="$(tmux show-option -gv status-right 2>/dev/null)"
STATUS_RIGHT_MIGRATED=${STATUS_RIGHT//"$LEGACY_OPTION"/$OPTION}
STATUS_RIGHT_MIGRATED="${STATUS_RIGHT_MIGRATED#"$MARKER_SEGMENT"}"
[ "$STATUS_RIGHT_MIGRATED" = "$STATUS_RIGHT" ] || tmux set-option -g status-right "$STATUS_RIGHT_MIGRATED"

install_clear_hook() {
	local hook_name="$1"
	local hook_command="$2"
	local line installed=""
	while IFS= read -r line; do
		case "$line" in
		*"$LEGACY_OPTION"*) tmux set-hook -gu "${line%% *}" ;;
		*"$OPTION"*) installed="yes" ;;
		esac
	done < <(tmux show-hooks -g "$hook_name" 2>/dev/null)
	[ -n "$installed" ] || tmux set-hook -ag "$hook_name" "$hook_command"
}

CLEAR_MARKER="set-option -wq -u $OPTION"
install_clear_hook after-select-window "$CLEAR_MARKER"
install_clear_hook session-window-changed "$CLEAR_MARKER"
install_clear_hook client-focus-in "$CLEAR_MARKER"

exit 0
