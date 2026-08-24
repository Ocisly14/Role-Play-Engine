extends SceneTree
## Headless assertions for SimLayout. Run:
##   godot --headless --path godot-client --script tests/test_layout.gd

const SimLayout := preload("res://scripts/sim_layout.gd")

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
