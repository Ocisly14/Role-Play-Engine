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
