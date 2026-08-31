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
