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
