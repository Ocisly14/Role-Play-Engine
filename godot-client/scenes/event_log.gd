class_name EventLog
extends RichTextLabel
## Scrolling feed of narrative simulation events.

const MAX_LINES := 300
const LOGGED_TYPES := [
	"action_executed", "action_failed", "action_interrupted",
	"npc_death", "day_transition", "simulation_state_changed",
]

var _lines := 0


func _ready() -> void:
	bbcode_enabled = true
	scroll_following = true
	fit_content = false


func log_event(event: Dictionary) -> void:
	var type := str(event.get("type", ""))
	if type not in LOGGED_TYPES:
		return
	var data: Dictionary = event.get("data", {})
	var time := str(event.get("gameDateTime", "")).substr(11, 5)  # "HH:MM"
	var line := ""
	match type:
		"action_executed", "action_failed", "action_interrupted":
			var who := str(data.get("characterName", event.get("actorNpcId", "?")))
			var action := str(data.get("action", ""))
			var outcome := str(data.get("outcome", ""))
			var color := "#c0c8d8" if type == "action_executed" else "#e5484d"
			line = "[color=#8a92a6]%s[/color] [color=%s][b]%s[/b][/color] %s" \
				% [time, color, who, action]
			if outcome != "":
				line += "\n    [color=#8a92a6]%s[/color]" % outcome
		"npc_death":
			line = "[color=#e5484d]%s ☠ %s[/color]" \
				% [time, str(event.get("actorNpcId", "?"))]
		"day_transition":
			line = "[color=#f5a623]── %s ──[/color]" % str(data.get("newDate", ""))
		"simulation_state_changed":
			line = "[color=#8a92a6]%s state: %s[/color]" \
				% [time, str(data.get("state", ""))]
	if line == "":
		return
	append_text(line + "\n")
	_lines += 1
	if _lines > MAX_LINES:
		# Cheap trim: drop everything, keep feed bounded.
		var tail := get_parsed_text().split("\n")
		clear()
		_lines = 0
		for keep in tail.slice(maxi(0, tail.size() - MAX_LINES / 2)):
			append_text(keep + "\n")
			_lines += 1
