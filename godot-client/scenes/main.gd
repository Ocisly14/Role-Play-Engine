extends Control
## Entry point: connection form -> bootstrap snapshots -> live view.

var _town_map: TownMap
var _event_log: EventLog
var _clock_label: Label
var _status_label: Label
var _connect_button: Button
var _host_edit: LineEdit
var _module_edit: LineEdit


func _ready() -> void:
	_apply_cjk_theme()
	_town_map = %TownMap
	_event_log = %EventLog
	_clock_label = %ClockLabel
	_status_label = %StatusLabel
	_connect_button = %ConnectButton
	_host_edit = %HostEdit
	_module_edit = %ModuleEdit
	_connect_button.pressed.connect(_on_connect_pressed)
	SimClient.sim_event.connect(_on_sim_event)
	SimClient.position_snapshot.connect(_on_snapshot)
	SimClient.ws_connected.connect(func(_session_id: String) -> void:
		_status_label.text = "Live")
	SimClient.ws_closed.connect(func() -> void:
		_status_label.text = "Disconnected")


func _apply_cjk_theme() -> void:
	# Godot's bundled font lacks CJK glyphs; use OS fonts (Chinese modules).
	var font := SystemFont.new()
	font.font_names = PackedStringArray(
		["PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "sans-serif"])
	var ui_theme := Theme.new()
	ui_theme.default_font = font
	theme = ui_theme


func _on_connect_pressed() -> void:
	_connect_button.disabled = true
	_status_label.text = "Connecting..."
	SimClient.base_url = _host_edit.text.strip_edges().trim_suffix("/")
	var ok := await _bootstrap(_module_edit.text.strip_edges())
	_status_label.text = "Connected — waiting for events" if ok else "Failed — check server/module name"
	_connect_button.disabled = false


func _bootstrap(module_name: String) -> bool:
	var session_id := await SimClient.resolve_session(module_name)
	if session_id == "":
		return false

	var status: Variant = await SimClient.get_json(
		"/api/simulation/%s/status" % session_id)
	var topology: Variant = await SimClient.get_json(
		"/api/simulation/%s/topology" % session_id)
	var statuses: Variant = await SimClient.get_json(
		"/api/simulation/%s/npc-statuses" % session_id)
	var positions: Variant = await SimClient.get_json(
		"/api/simulation/%s/positions" % session_id)
	if not (topology is Dictionary and statuses is Dictionary):
		return false

	var map_config: Dictionary = {}
	if status is Dictionary and status.get("mapsPrefix"):
		var encoded_prefix := "/".join(
			str(status["mapsPrefix"]).split("/").map(
				func(part: String) -> String: return part.uri_encode()))
		var config: Variant = await SimClient.get_json(
			"/api/maps/%s/map_config.json" % encoded_prefix)
		if config is Dictionary:
			map_config = config

	_town_map.build(topology, map_config, statuses.get("statuses", []))
	if positions is Dictionary:
		_town_map.apply_positions(positions.get("positions", {}), 200.0)
	if status is Dictionary:
		_clock_label.text = str(status.get("currentDateTime", ""))

	SimClient.connect_ws(session_id)
	return true


func _on_sim_event(event: Dictionary) -> void:
	var game_dt := str(event.get("gameDateTime", ""))
	if game_dt != "":
		_clock_label.text = game_dt
	if str(event.get("type", "")) == "npc_death":
		_town_map.mark_dead(str(event.get("actorNpcId", "")))
	_event_log.log_event(event)


func _on_snapshot(
		positions: Dictionary, _actions: Dictionary, interval_ms: float) -> void:
	_town_map.apply_positions(positions, interval_ms)
