# Item Changes

Item changes govern existence, ownership, location, description and functional
properties. Each entry names its `sourceActionId`; existing items also name
their `itemId`.

## Conservation and ownership

An item has one holder at a time. A holder is either `scene:<placeId>` or a
character id.

- A transfer has one actual current holder and one valid destination.
- Consumption or irreversible loss uses `destroy`; do not leave a destroyed
  item in a scene or inventory.
- Creation needs a cause in this tick. Do not materialize convenient tools,
  loot or scenery merely because they would fit the narration.
- Concurrent claims produce one atomic winner or an explicit failure; never
  duplicate an item.

## Available operations

- `create {name, location, description?, id?}` — create a genuinely new,
  persistent item. Supply a stable unused id for a non-Latin name.
- `move {from, to}` — relocate an existing item from its exact current holder,
  whether by transfer, deliberate placement or external force.
- `destroy {}` — remove an item that no longer exists as a meaningful object.
- `set {description?, appendDescription?, hidden?, isLightSource?,
  lightLevel?}` — change what an existing item is like without changing its
  identity or holder.

A `set` operation must change at least one field. Replace or append a
description, never both in the same operation.

## Movement by force

Items do not use `movement.route`. When an action or physical force changes an
item's holder, use `item.move` with its exact current `from` holder and final
`to` holder. Examples include:

- an object thrown, kicked or blasted from one scene into another;
- an item knocked out of a character's hand onto the ground;
- debris carried into another scene by water, wind or a collision;
- an object picked up, handed over, dropped or deliberately placed.

If the item remains in the same scene, the state model has no item-level
`spot`. Do not emit a no-op move whose `from` and `to` are the same holder.
Record the displacement in an occurrence; rewrite the scene description only
when the new resting place is a persistent, materially relevant part of that
scene.

Movement and damage are independent. A force may require:

- only `move` when the item changes holder intact;
- only `set` or `destroy` when it is damaged without leaving its holder;
- `move` together with `set` when it lands elsewhere in a changed state;
- `destroy` instead of `move` when no meaningful original item survives.

Items inside a vehicle's interior scene remain held by that scene while the
vehicle travels. Do not move every carried item separately with the vehicle.

## Damage, breakage and dismantling

Choose the operation from the object's resulting identity and function:

- Cosmetic or localized damage that leaves the same usable object is `set`
  with `appendDescription`.
- A changed but still identifiable object is `set` with a complete replacement
  `description`, plus functional fields such as `isLightSource:false` when
  applicable.
- An object that has ceased to exist as an interactable whole is `destroy`.
- If dismantling produces one or more new parts that remain independently
  relevant, `destroy` the original and `create` only those persistent parts.
  Do not generate a cloud of irrelevant fragments as separate items.

Damage does not automatically mean destruction. Describe and apply only what
the action, tools and deterministic damage result support.

## Hidden and revealed items

Use `set.hidden:false` when an existing concealed item becomes available to
ordinary perception, and `set.hidden:true` only when an action actually
conceals it. Knowing privately where something is does not necessarily reveal
it to the whole scene.

## Scene-description coherence

When an item's current scene description contains its `[itemId]` citation,
moving or destroying it requires a `scene.setDescription` in the same
resolution. Rewrite the whole scene prose, preserving every still-true
reference and removing the stale citation.
