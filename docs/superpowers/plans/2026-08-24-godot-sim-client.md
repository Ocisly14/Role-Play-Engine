# Godot Simulation Viewer Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal read-only Godot 4 client that connects to the existing simulation server, renders the town map + NPC positions live, and shows a scrolling event log.

**Architecture:** Godot is a pure viewer — zero backend changes. It uses the existing unauthenticated simulation-viewer surface: REST snapshot endpoints (`/api/simulation/:id/*`) to bootstrap, then a WebSocket (`/ws?sessionId=X&type=simulation`) for live `simulation_event` messages. NPC movement is driven by the per-tick `npc_position_snapshot` event (full-state, self-correcting) and smoothed client-side with tweens.

**Tech Stack:** Godot 4.4 (GL Compatibility renderer), GDScript only. No plugins, no GUT — one headless assertion script covers the algorithmic layout code.

**Spec:** No separate spec doc — the protocol reference below is the spec (verified against `client/server/` and `src/simulation/` on 2026-08-24).

## Global Constraints

- New directory `godot-client/` at repo root; **no changes to any existing TS file**.
- Server default: `http://localhost:3000` (from `client/server.ts:48`); base URL must be user-editable in the UI.
- GDScript style: `snake_case`, typed where practical, tab indentation (Godot default).
- Per user workflow prefs: **no per-task commits** — one commit at the very end after user review; **no auto-running** the app — the user launches Godot/server themselves; verification is batched in the final task.
- CJK support: module data may be Chinese (`Cassandra_zh`); UI must use a `SystemFont` fallback (PingFang SC on macOS) or labels will render as boxes.

## Protocol Reference (the spec)

**REST** (all GET, no auth, JSON; mounted at `/api` — see `client/server/simulation/mapRoutes.ts`):

| Endpoint | Returns |
|---|---|
| `/api/simulation/resolve/:moduleName` | `{ sessionId }` for a running/persisted sim of that module |
| `/api/simulation/:id/status` | `{ state, currentDateTime, ticksExecuted, weather?, mapsPrefix? }` |
| `/api/simulation/:id/topology` | `TopologyResponse` — see below |
| `/api/simulation/:id/positions` | `{ positions: { [npcId]: CharacterPosition } }` |
| `/api/simulation/:id/npc-statuses` | `{ statuses: [{ npcId, name, hp, maxHp, san, maxSan, currentAction, location, isAlive, ... }] }` |
| `/api/maps/<mapsPrefix>/map_config.json` | `{ town: {background}, scenarios: {SCN_1: {x, y, thumbnail}}, scenes: {...} }` |

`TopologyResponse` (`src/simulation/mapViewerTypes.ts:31`): `junctions[] {id, name, parentLocationId, connectedSceneIds}`, `roads[] {id, name, parentLocationId, endpointA, endpointB, travelTimeMinutes, alongConnections}`, `scenes[] {id, name, description, parentLocationId, conditions, connections}`, `scenarioOutlines[] {id, name, description, entrySceneId?, subSceneCount}`, `transportEdges[]`.

`CharacterPosition` (`src/state/topologyTypes.ts:54`) is a tagged union:
```
{ "type": "junction", "junctionId": "..." }
{ "type": "road", "roadId": "...", "position": 0.42 }   # fraction 0..1
{ "type": "scene", "sceneId": "..." }
```

**WebSocket**: `ws://<host>/ws?sessionId=<id>&type=simulation` — no auth (`WebSocketManager.ts:50`). Messages:
```
{ "type": "connected", "sessionId": "...", "timestamp": "..." }
{ "type": "simulation_event", "event": SimulationEvent }
```
`SimulationEvent` (`src/simulation/types.ts:17`): `{ id, sessionId, tick, gameDateTime, type, actorNpcId, targetNpcId?, location, data, timestamp }`.

Event types to handle: `npc_position_snapshot` (per tick, `data = { positions, currentActions, displayIntervalMs, weather }` — `SimulationRunner.ts:705`), `action_executed|action_failed|action_interrupted` (`data = { action, characterName, outcome, gameTime }`), `day_transition`, `npc_death`, `simulation_state_changed`. Others may arrive — ignore unknown types gracefully.

**Known gaps** (accepted for v1): `npc_moved` is declared but never emitted (snapshot covers movement); snapshot `weather` is hard-coded `"clear"`; only scenarios have x/y coordinates (`map_config.json`), junctions/scenes are positioned via their `parentLocationId` scenario.

## File Structure

```
godot-client/
  project.godot                  # Godot 4.4 project, autoload SimClient
  .gitignore                     # .godot/ import cache
  scripts/
    sim_client.gd                # autoload: REST + WS bridge, signals
    sim_layout.gd                # class_name SimLayout: pure layout/interpolation functions
  scenes/
    main.tscn / main.gd          # connect UI + assembles map, log, clock
    town_map.gd                  # Node2D: draws topology, owns NPC markers
    npc_marker.gd                # Node2D: one NPC dot + name label, tweened movement
    event_log.gd                 # RichTextLabel: scrolling event feed
  tests/
    test_layout.gd               # headless assertions for SimLayout
```

Scene files other than `main.tscn` are built in code (scripts instantiated by `main.gd`), so no hand-authored `.tscn` beyond main — fewer opaque binary-ish diffs.

---

### Task 1: Project skeleton + SimClient autoload (REST + WebSocket)

**Files:**
- Create: `godot-client/project.godot`
- Create: `godot-client/.gitignore`
- Create: `godot-client/scripts/sim_client.gd`

**Interfaces:**
- Produces (used by every later task): autoload singleton `SimClient` with
  - `base_url: String` (default `"http://localhost:3000"`)
  - `resolve_session(module_name: String) -> String` (async; `""` on failure)
  - `get_json(path: String) -> Variant` (async; parsed JSON or `null`)
  - `connect_ws(session_id: String) -> void`, `disconnect_ws() -> void`
  - signals: `ws_connected(session_id: String)`, `ws_closed()`, `sim_event(event: Dictionary)`, `position_snapshot(positions: Dictionary, current_actions: Dictionary, interval_ms: float)`

- [ ] **Step 1: Write `project.godot` and `.gitignore`**

`godot-client/project.godot`:
```ini
; Engine configuration file.
config_version=5

[application]

config/name="CoC Sim Viewer"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.4", "GL Compatibility")

[autoload]

SimClient="*res://scripts/sim_client.gd"

[display]

window/size/viewport_width=1280
window/size/viewport_height=720

[rendering]

renderer/rendering_method="gl_compatibility"
```

`godot-client/.gitignore`:
```gitignore
.godot/
```

- [ ] **Step 2: Write `scripts/sim_client.gd`**

```gdscript
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
	session_id = p_session_id
	# http -> ws, https -> wss
	var ws_url := base_url.replace("http", "ws") \
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
```

No test for this file (thin I/O delegation — user pref: skip trivial tests); it is exercised end-to-end in Task 5.

---

### Task 2: SimLayout — pure layout + position resolution, with headless test

**Files:**
- Create: `godot-client/scripts/sim_layout.gd`
- Test: `godot-client/tests/test_layout.gd`

**Interfaces:**
- Consumes: nothing (pure static functions; no SimClient dependency).
- Produces (used by Task 3):
  - `SimLayout.scenario_positions(outlines: Array, map_config: Dictionary) -> Dictionary` — `{scenario_id: Vector2}`; configured scenarios use `map_config.scenarios[id].x/y`, the rest fall back to a radial ring around `(400, 300)` (same rule as the Phaser `TownScene.ts:284`).
  - `SimLayout.build_index(topology: Dictionary) -> Dictionary` — `{"scene_parent": {scene_id: scenario_id}, "junction_parent": {junction_id: scenario_id}, "roads": {road_id: {"a": junction_id, "b": junction_id}}}`.
  - `SimLayout.resolve_position(pos: Dictionary, index: Dictionary, scenario_pos: Dictionary) -> Variant` — `Vector2` for any `CharacterPosition` union member, or `null` if unresolvable.

- [ ] **Step 1: Write the failing test**

`godot-client/tests/test_layout.gd`:
```gdscript
extends SceneTree
## Headless assertions for SimLayout. Run:
##   godot --headless --path godot-client --script tests/test_layout.gd

var failures := 0


func check(cond: bool, name: String) -> void:
	if cond:
		print("PASS  " + name)
	else:
		failures += 1
		push_error("FAIL  " + name)


func _init() -> void:
	var outlines := [{"id": "SCN_1"}, {"id": "SCN_2"}, {"id": "SCN_3"}]
	var config := {"scenarios": {"SCN_1": {"x": 100, "y": 200}}}

	var pos: Dictionary = SimLayout.scenario_positions(outlines, config)
	check(pos["SCN_1"] == Vector2(100, 200), "configured scenario uses map_config coords")
	check(pos.has("SCN_2") and pos.has("SCN_3"), "unpositioned scenarios get fallback coords")
	check(pos["SCN_2"] != pos["SCN_3"], "fallback coords are distinct")
	check(pos["SCN_2"].distance_to(Vector2(400, 300)) > 100.0,
		"fallback ring has usable radius")

	var topology := {
		"scenes": [{"id": "S1", "parentLocationId": "SCN_1"}],
		"junctions": [
			{"id": "J1", "parentLocationId": "SCN_1"},
			{"id": "J2", "parentLocationId": "SCN_2"},
		],
		"roads": [{"id": "R1", "endpointA": "J1", "endpointB": "J2"}],
	}
	var index: Dictionary = SimLayout.build_index(topology)

	var scene_xy: Variant = SimLayout.resolve_position(
		{"type": "scene", "sceneId": "S1"}, index, pos)
	check(scene_xy == Vector2(100, 200), "scene resolves to parent scenario pos")

	var junction_xy: Variant = SimLayout.resolve_position(
		{"type": "junction", "junctionId": "J2"}, index, pos)
	check(junction_xy == pos["SCN_2"], "junction resolves to parent scenario pos")

	var road_xy: Variant = SimLayout.resolve_position(
		{"type": "road", "roadId": "R1", "position": 0.5}, index, pos)
	check(road_xy == pos["SCN_1"].lerp(pos["SCN_2"], 0.5),
		"road position lerps between endpoint scenario positions")

	var bogus: Variant = SimLayout.resolve_position(
		{"type": "scene", "sceneId": "NOPE"}, index, pos)
	check(bogus == null, "unknown location resolves to null")

	quit(1 if failures > 0 else 0)
```

- [ ] **Step 2: Note the expected failure mode**

Run (Task 5 batches actual execution; if run now): `godot --headless --path godot-client --script tests/test_layout.gd`
Expected before implementation: script error — `SimLayout` not declared.

- [ ] **Step 3: Write `scripts/sim_layout.gd`**

```gdscript
class_name SimLayout
## Pure functions mapping topology + map_config to 2D canvas coordinates.
## Mirrors the layout rules of the Phaser TownScene renderer.

const FALLBACK_CENTER := Vector2(400, 300)


static func scenario_positions(outlines: Array, map_config: Dictionary) -> Dictionary:
	var configured: Dictionary = map_config.get("scenarios", {})
	var result: Dictionary = {}
	var unpositioned: Array[String] = []
	for outline in outlines:
		var id := str(outline.get("id", ""))
		if id == "":
			continue
		var entry: Variant = configured.get(id)
		if entry is Dictionary and entry.has("x") and entry.has("y"):
			result[id] = Vector2(float(entry["x"]), float(entry["y"]))
		else:
			unpositioned.append(id)
	var radius: float = max(150.0, unpositioned.size() * 40.0)
	for i in unpositioned.size():
		var angle := -PI / 2.0 + TAU * float(i) / float(unpositioned.size())
		result[unpositioned[i]] = FALLBACK_CENTER \
			+ Vector2(cos(angle), sin(angle)) * radius
	return result


static func build_index(topology: Dictionary) -> Dictionary:
	var scene_parent: Dictionary = {}
	for scene in topology.get("scenes", []):
		scene_parent[str(scene["id"])] = str(scene.get("parentLocationId", ""))
	var junction_parent: Dictionary = {}
	for junction in topology.get("junctions", []):
		junction_parent[str(junction["id"])] = str(junction.get("parentLocationId", ""))
	var roads: Dictionary = {}
	for road in topology.get("roads", []):
		roads[str(road["id"])] = {
			"a": str(road.get("endpointA", "")),
			"b": str(road.get("endpointB", "")),
		}
	return {
		"scene_parent": scene_parent,
		"junction_parent": junction_parent,
		"roads": roads,
	}


static func resolve_position(
		pos: Dictionary, index: Dictionary, scenario_pos: Dictionary) -> Variant:
	match pos.get("type", ""):
		"scene":
			return _scenario_xy(
				index["scene_parent"].get(str(pos.get("sceneId", ""))), scenario_pos)
		"junction":
			return _junction_xy(str(pos.get("junctionId", "")), index, scenario_pos)
		"road":
			var road: Variant = index["roads"].get(str(pos.get("roadId", "")))
			if not road is Dictionary:
				return null
			var a: Variant = _junction_xy(road["a"], index, scenario_pos)
			var b: Variant = _junction_xy(road["b"], index, scenario_pos)
			if a == null or b == null:
				return a if b == null else b
			return (a as Vector2).lerp(b as Vector2,
				clampf(float(pos.get("position", 0.0)), 0.0, 1.0))
	return null


static func _junction_xy(
		junction_id: String, index: Dictionary, scenario_pos: Dictionary) -> Variant:
	return _scenario_xy(index["junction_parent"].get(junction_id), scenario_pos)


static func _scenario_xy(scenario_id: Variant, scenario_pos: Dictionary) -> Variant:
	if scenario_id == null:
		return null
	return scenario_pos.get(str(scenario_id))
```

- [ ] **Step 4: Defer test execution to Task 5** (user pref: batch verification at end; user runs commands).

---

### Task 3: TownMap + NpcMarker rendering

**Files:**
- Create: `godot-client/scenes/npc_marker.gd`
- Create: `godot-client/scenes/town_map.gd`

**Interfaces:**
- Consumes: `SimLayout.scenario_positions / build_index / resolve_position` (Task 2 signatures).
- Produces (used by Task 4):
  - `NpcMarker` (`class_name`, extends `Node2D`): `setup(npc_id: String, npc_name: String, color: Color) -> void`, `move_to(target: Vector2, duration: float) -> void`, `set_dead() -> void`, property `npc_id: String`.
  - `TownMap` (`class_name`, extends `Node2D`): `build(topology: Dictionary, map_config: Dictionary, statuses: Array) -> void`, `apply_positions(positions: Dictionary, interval_ms: float) -> void`, `mark_dead(npc_id: String) -> void`.

- [ ] **Step 1: Write `scenes/npc_marker.gd`**

```gdscript
class_name NpcMarker
extends Node2D
## One NPC on the town map: colored dot + name label, tween-smoothed movement.

var npc_id := ""
var _color := Color.WHITE
var _alive := true
var _tween: Tween


func setup(p_npc_id: String, npc_name: String, color: Color) -> void:
	npc_id = p_npc_id
	_color = color
	var label := Label.new()
	label.name = "NameLabel"
	label.text = npc_name
	label.position = Vector2(-40, 8)
	label.custom_minimum_size = Vector2(80, 0)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 11)
	add_child(label)
	queue_redraw()


func move_to(target: Vector2, duration: float) -> void:
	if _tween and _tween.is_valid():
		_tween.kill()
	_tween = create_tween()
	_tween.tween_property(self, "position", target, duration) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)


func set_dead() -> void:
	_alive = false
	modulate = Color(0.5, 0.5, 0.5, 0.7)
	queue_redraw()


func _draw() -> void:
	draw_circle(Vector2.ZERO, 7.0, _color if _alive else Color.DIM_GRAY)
	draw_arc(Vector2.ZERO, 7.0, 0.0, TAU, 24, Color.BLACK, 1.5)
```

- [ ] **Step 2: Write `scenes/town_map.gd`**

```gdscript
class_name TownMap
extends Node2D
## Draws the town graph (scenario nodes + road edges) and owns NPC markers.

const MARKER_COLORS: Array[Color] = [
	Color("e5484d"), Color("30a46c"), Color("0091ff"), Color("f5a623"),
	Color("8e4ec6"), Color("12a594"), Color("e93d82"), Color("996a3a"),
]
const CO_LOCATED_SPACING := 28.0
const CO_LOCATED_Y_OFFSET := 36.0

var _scenario_pos: Dictionary = {}
var _index: Dictionary = {}
var _markers: Dictionary = {}  # npc_id -> NpcMarker


func build(topology: Dictionary, map_config: Dictionary, statuses: Array) -> void:
	for child in get_children():
		child.queue_free()
	_markers.clear()

	_scenario_pos = SimLayout.scenario_positions(
		topology.get("scenarioOutlines", []), map_config)
	_index = SimLayout.build_index(topology)

	_draw_roads(topology)
	_draw_scenario_nodes(topology)
	_spawn_markers(statuses)


func _draw_roads(topology: Dictionary) -> void:
	for road in topology.get("roads", []):
		var a: Variant = SimLayout.resolve_position(
			{"type": "junction", "junctionId": str(road["endpointA"])},
			_index, _scenario_pos)
		var b: Variant = SimLayout.resolve_position(
			{"type": "junction", "junctionId": str(road["endpointB"])},
			_index, _scenario_pos)
		if a == null or b == null or a == b:
			continue
		var line := Line2D.new()
		line.points = PackedVector2Array([a, b])
		line.width = 3.0
		line.default_color = Color(0.55, 0.5, 0.42, 0.8)
		line.z_index = -1
		add_child(line)


func _draw_scenario_nodes(topology: Dictionary) -> void:
	for outline in topology.get("scenarioOutlines", []):
		var id := str(outline.get("id", ""))
		if not _scenario_pos.has(id):
			continue
		var node := Node2D.new()
		node.position = _scenario_pos[id]
		var dot := Polygon2D.new()
		var pts := PackedVector2Array()
		for i in 20:
			pts.append(Vector2.from_angle(TAU * i / 20.0) * 16.0)
		dot.polygon = pts
		dot.color = Color(0.25, 0.28, 0.35)
		node.add_child(dot)
		var label := Label.new()
		label.text = str(outline.get("name", id))
		label.position = Vector2(-60, -40)
		label.custom_minimum_size = Vector2(120, 0)
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.add_theme_font_size_override("font_size", 13)
		node.add_child(label)
		add_child(node)


func _spawn_markers(statuses: Array) -> void:
	for i in statuses.size():
		var status: Dictionary = statuses[i]
		var marker := NpcMarker.new()
		marker.setup(
			str(status.get("npcId", "")),
			str(status.get("name", "?")),
			MARKER_COLORS[i % MARKER_COLORS.size()])
		if not bool(status.get("isAlive", true)):
			marker.set_dead()
		marker.z_index = 1
		add_child(marker)
		_markers[marker.npc_id] = marker


func apply_positions(positions: Dictionary, interval_ms: float) -> void:
	# Group co-located NPCs so markers fan out instead of stacking.
	var by_target: Dictionary = {}  # "x,y" -> Array[npc_id]
	var targets: Dictionary = {}    # npc_id -> Vector2
	var npc_ids: Array = positions.keys()
	npc_ids.sort()
	for npc_id in npc_ids:
		if not _markers.has(npc_id):
			continue
		var xy: Variant = SimLayout.resolve_position(
			positions[npc_id], _index, _scenario_pos)
		if xy == null:
			continue
		targets[npc_id] = xy
		var key := "%d,%d" % [int((xy as Vector2).x), int((xy as Vector2).y)]
		if not by_target.has(key):
			by_target[key] = []
		by_target[key].append(npc_id)

	var duration: float = clampf(interval_ms / 1000.0, 0.2, 5.0)
	for key in by_target:
		var group: Array = by_target[key]
		for i in group.size():
			var npc_id: String = group[i]
			var offset := Vector2(
				(float(i) - float(group.size() - 1) / 2.0) * CO_LOCATED_SPACING,
				CO_LOCATED_Y_OFFSET)
			_markers[npc_id].move_to((targets[npc_id] as Vector2) + offset, duration)


func mark_dead(npc_id: String) -> void:
	if _markers.has(npc_id):
		_markers[npc_id].set_dead()
```

No dedicated tests (rendering/scene-tree code — the algorithmic part already lives in tested `SimLayout`). Verified visually in Task 5.

---

### Task 4: Event log, clock, and Main scene wiring

**Files:**
- Create: `godot-client/scenes/event_log.gd`
- Create: `godot-client/scenes/main.gd`
- Create: `godot-client/scenes/main.tscn`

**Interfaces:**
- Consumes: `SimClient` signals + `get_json`/`resolve_session`/`connect_ws` (Task 1); `TownMap.build/apply_positions/mark_dead` (Task 3).
- Produces: runnable app — main scene per `project.godot`.

- [ ] **Step 1: Write `scenes/event_log.gd`**

```gdscript
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
```

- [ ] **Step 2: Write `scenes/main.gd`**

```gdscript
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
	_status_label.text = "Live" if ok else "Failed — check server/module name"
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
		var config: Variant = await SimClient.get_json(
			"/api/maps/%s/map_config.json" % str(status["mapsPrefix"]))
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
```

- [ ] **Step 3: Write `scenes/main.tscn`**

```ini
[gd_scene load_steps=5 format=3 uid="uid://cocsimviewermain"]

[ext_resource type="Script" path="res://scenes/main.gd" id="1"]
[ext_resource type="Script" path="res://scenes/town_map.gd" id="2"]
[ext_resource type="Script" path="res://scenes/event_log.gd" id="3"]

[sub_resource type="StyleBoxFlat" id="panel_bg"]
bg_color = Color(0.09, 0.1, 0.13, 1)

[node name="Main" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
script = ExtResource("1")

[node name="Background" type="ColorRect" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
color = Color(0.13, 0.14, 0.17, 1)

[node name="TopBar" type="HBoxContainer" parent="."]
layout_mode = 1
anchors_preset = 10
anchor_right = 1.0
offset_left = 12.0
offset_top = 8.0
offset_right = -12.0
offset_bottom = 44.0
theme_override_constants/separation = 8

[node name="HostEdit" type="LineEdit" parent="TopBar"]
unique_name_in_owner = true
layout_mode = 2
custom_minimum_size = Vector2(220, 0)
text = "http://localhost:3000"

[node name="ModuleEdit" type="LineEdit" parent="TopBar"]
unique_name_in_owner = true
layout_mode = 2
custom_minimum_size = Vector2(180, 0)
placeholder_text = "module name (e.g. simple_town)"

[node name="ConnectButton" type="Button" parent="TopBar"]
unique_name_in_owner = true
layout_mode = 2
text = "Connect"

[node name="StatusLabel" type="Label" parent="TopBar"]
unique_name_in_owner = true
layout_mode = 2
text = "Idle"

[node name="ClockLabel" type="Label" parent="TopBar"]
unique_name_in_owner = true
layout_mode = 2
size_flags_horizontal = 10
text = "--"

[node name="MapViewport" type="SubViewportContainer" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
offset_left = 12.0
offset_top = 52.0
offset_right = -372.0
offset_bottom = -12.0
stretch = true

[node name="SubViewport" type="SubViewport" parent="MapViewport"]
transparent_bg = true
handle_input_locally = false
size = Vector2i(896, 656)
render_target_update_mode = 4

[node name="TownMap" type="Node2D" parent="MapViewport/SubViewport"]
unique_name_in_owner = true
script = ExtResource("2")

[node name="LogPanel" type="PanelContainer" parent="."]
layout_mode = 1
anchors_preset = 11
anchor_left = 1.0
anchor_right = 1.0
anchor_bottom = 1.0
offset_left = -360.0
offset_top = 52.0
offset_right = -12.0
offset_bottom = -12.0
theme_override_styles/panel = SubResource("panel_bg")

[node name="EventLog" type="RichTextLabel" parent="LogPanel"]
unique_name_in_owner = true
layout_mode = 2
script = ExtResource("3")
```

Note: `%NodeName` lookups in `main.gd` rely on the `unique_name_in_owner = true` flags above. `TownMap` sits inside a `SubViewport` so map coordinates are independent of UI layout; map camera/pan-zoom is deliberately out of scope for v1 (map_config coords for `simple_town` fit in ~800×600).

---

### Task 5: Batched verification + single commit

**Files:** none created — verification only.

Per user prefs this is the single verification point, and **the user runs the commands** (don't auto-run). Present this checklist and wait:

- [ ] **Step 1: Headless layout test**

```bash
godot --headless --path godot-client --script tests/test_layout.gd
```
Expected: 8 `PASS` lines, exit code 0.

- [ ] **Step 2: Server up + a running simulation**

```bash
pnpm chat          # terminal 1 — starts API + WS on :3000
```
Then start (or resume) a simulation for `simple_town` from the React frontend (`pnpm chat:frontend`) or existing session. Confirm `curl http://localhost:3000/api/simulation/resolve/simple_town` returns a `sessionId`.

- [ ] **Step 3: Godot end-to-end**

Open `godot-client/` in Godot 4.4, run the main scene, enter module name `simple_town`, press Connect. Expected:
- Status flips to `Live`; clock shows the sim's `gameDateTime` and advances each tick.
- Scenario nodes + roads drawn; NPC dots with names sit on nodes; on each tick markers glide (not teleport) to new positions; co-located NPCs fan out instead of stacking.
- Event log fills with `HH:MM Name action` lines (Chinese text renders if using `Cassandra_zh`).
- Killing the server flips status to `Disconnected` without crashing.

- [ ] **Step 4: One commit, after user review**

```bash
git add godot-client/ docs/superpowers/plans/2026-08-24-godot-sim-client.md
git commit -m "feat(godot-client): minimal Godot 4 simulation viewer (map + live events)"
```

---

## Out of scope (explicit v1 cuts — future follow-ups)

- Interior scene views (per-scene backgrounds / `npcAreas` from `map_config.json`)
- NPC detail panel (`npc-statuses` HP/SAN/inventory), event history backfill (`/events`), playback status
- Weather rendering (server snapshot is hard-coded `"clear"` — needs the Phase E backend follow-up first)
- Map pan/zoom camera, scenario thumbnails/背景图, WS auto-reconnect
- Any player-participation path (would need a backend action-injection surface)
