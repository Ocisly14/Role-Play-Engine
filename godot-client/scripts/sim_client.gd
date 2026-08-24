extends Node
## Autoload bridge to the CoC simulation server: REST snapshots + live WS events.

signal ws_connected(session_id: String)
signal ws_closed()
signal sim_event(event: Dictionary)
signal position_snapshot(positions: Dictionary, current_actions: Dictionary, interval_ms: float)

var base_url := "http://localhost:3000"
var session_id := ""

var _ws := WebSocketPeer.new()
var _ws_active := false


func _process(_delta: float) -> void:
	if not _ws_active:
		return
	_ws.poll()
	match _ws.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			while _ws.get_available_packet_count() > 0:
				_handle_message(_ws.get_packet().get_string_from_utf8())
		WebSocketPeer.STATE_CLOSED:
			_ws_active = false
			ws_closed.emit()


func get_json(path: String) -> Variant:
	var req := HTTPRequest.new()
	add_child(req)
	req.timeout = 10.0
	if req.request(base_url + path) != OK:
		req.queue_free()
		return null
	var result: Array = await req.request_completed
	req.queue_free()
	var code: int = result[1]
	if code != 200:
		return null
	var body: PackedByteArray = result[3]
	return JSON.parse_string(body.get_string_from_utf8())


func resolve_session(module_name: String) -> String:
	var data: Variant = await get_json(
		"/api/simulation/resolve/" + module_name.uri_encode())
	if data is Dictionary and data.has("sessionId"):
		return str(data["sessionId"])
	return ""


func connect_ws(p_session_id: String) -> void:
	disconnect_ws()
	_ws = WebSocketPeer.new()
	session_id = p_session_id
	# http -> ws, https -> wss (replace only the scheme prefix)
	var ws_url := "ws" + base_url.trim_prefix("http") \
		+ "/ws?sessionId=%s&type=simulation" % session_id.uri_encode()
	if _ws.connect_to_url(ws_url) == OK:
		_ws_active = true


func disconnect_ws() -> void:
	if _ws_active:
		_ws.close()
		_ws_active = false


func _handle_message(text: String) -> void:
	var msg: Variant = JSON.parse_string(text)
	if not msg is Dictionary:
		return
	match msg.get("type", ""):
		"connected":
			ws_connected.emit(str(msg.get("sessionId", "")))
		"simulation_event":
			var event: Variant = msg.get("event")
			if not event is Dictionary:
				return
			sim_event.emit(event)
			if event.get("type", "") == "npc_position_snapshot":
				var data: Dictionary = event.get("data", {})
				position_snapshot.emit(
					data.get("positions", {}),
					data.get("currentActions", {}),
					float(data.get("displayIntervalMs", 60000.0)))
