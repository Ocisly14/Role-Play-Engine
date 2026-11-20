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
  persistent item. `id` is REQUIRED when the name has no Latin letters or
  digits: code derives an id from those, and a name it can derive nothing
  from yields ids that tell the items apart in no readable way. Supply a
  short, stable, unused ascii id.
- `move {from, to}` — relocate an existing item from its exact current holder,
  whether by transfer, deliberate placement or external force.
- `destroy {}` — remove an item that no longer exists as a meaningful object.
- `set {description?, appendDescription?, isLightSource?,
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

If the item stays in the same place, do not emit a `move` whose `from` and
`to` are the same holder. Where it now is within the place is its
`placement`: change it with `place {placement, container}` — `container` is
the item it now sits in, or `""` when it sits in nothing. Correct an item
description that asserts its old position.

Movement and damage are independent. A force may require:

- only `move` when the item changes holder intact;
- only `set` or `destroy` when it is damaged without leaving its holder;
- `move` together with `set` when it lands elsewhere in a changed state;
- `destroy` instead of `move` when no meaningful original item survives.

Items inside a vehicle's interior scene remain held by that scene while the
vehicle travels. Do not move every carried item separately with the vehicle.

## Damage, breakage and dismantling

Choose the operation from the object's resulting identity and function:

- Cosmetic or localized damage that leaves the same usable object is `set`.
  Use `appendDescription` only if every existing claim remains true; otherwise
  replace `description` and preserve its unaffected details.
- A changed but still identifiable object is `set` with a complete replacement
  `description`, plus functional fields such as `isLightSource:false` when
  applicable.
- An object that has ceased to exist as an interactable whole is `destroy`.
- If dismantling produces one or more new parts that remain independently
  relevant, `destroy` the original and `create` only those persistent parts.
  Do not generate a cloud of irrelevant fragments as separate items.

Damage does not automatically mean destruction. Describe and apply only what
the action, tools and deterministic damage result support.

## Where a thing is: fixtures, placement, containers

There is no hidden flag. Every item at a place is exactly one of:

- a **fixture** — cited in the place's `setting` (a counter, a phone fixed to
  the wall). It has no placement. Taking it away or destroying it changes the
  place itself: the same submission rewrites the setting (`setSetting`).
- **placed** — it has a `placement` and no `container`. Anyone at the place
  can see it.
- **in a container** — it has a `placement` and a `container`. The Items
  section marks it `unnoticed`: it is there, out of plain view. Whether a
  given person sees it is judged per viewer from the container's own
  description, where they stand and what they are doing.

placement: where the thing is within the place, as a short phrase ("beside the till", "in the till drawer"). Required for every item put down at a place; a fixture the place's setting cites has none.

container: the id of the item it sits inside, under or behind, when that item can hide it (a drawer, a closed cabinet, a suitcase, a mattress). Whether it can be seen is that container's own description — open or shut, clear or solid, which way it faces. An open shelf, a knife block or a tray hides nothing and is never a container.

- When an item comes to rest at a place (set down on the counter, dropped in
  the road), the `move` carries its `placement` (and `container: ""` unless
  it went into something). Moving to a character, both are `""`. Never move
  an item to a place without a placement.
- When an action hides an item (under the mattress, into the drawer), give it
  that `container`. A thing put away out of sight is a thing in a container.
- When an action lays a contained item open for anyone to see (the drawer
  emptied onto the table), `place {placement, container: ""}` takes it out.
  Opening or shutting the container itself is a `set {description}` on the
  container — what is inside does not change.
- What sits in a container goes with it when the container is moved; when a
  container is destroyed, what was in it stays where it was, loose.
- When an action brings a new item into being (`create` — a leg pried off a
  chair, a note written): in someone's hands it needs nothing more; at a
  place it carries a `placement`, and a `container` when it was made out of
  sight. The occurrence that shows it names it with its `[id]`, and the thing
  it came from is rewritten (`set` on the chair, `setSetting` on the place
  when a fixture lost a part) so the world does not keep the part in two
  places.
- An item with a `quantity` stands for that many identical things (a case of
  18 tarts). Taking some of them: `set {quantity}` on the stack to what is
  left, and `create` what was taken — in someone's hands or at its new
  placement, with its own `quantity` when more than one. Taking all of them
  is a `move` of the whole item; using up the last one is `destroy`, never a
  quantity of 0. Never leave the stack's count as it was after some were
  taken.
- Someone FINDING a contained item is their knowledge, not a change: an
  occurrence that names the item, perceived by the finder. Nothing here.

## Setting coherence

Before submitting, compare each affected item's CURRENT holder, existence,
description and functional fields with the accepted outcomes. Updating one
field does not update the others: `move` changes the holder only, never prose.
If a map described as spread on a table was folded and taken away, submit
both `move` and `set {description}` for that item, with the same causal action.
Remove the obsolete placement and record the supported folded state while
preserving its material and markings. Do not append a new sentence while
leaving the contradictory old sentence intact. Unchanged identity or function
does not excuse a stale description, and a transfer is not mere handling.

Repair the item's OWN description in this phase; the scene phase separately
repairs the surrounding place. Neither repair substitutes for the other.
Submit `[]` only after checking both structural fields and descriptive claims.

When an item is a fixture — its place's setting contains its `[itemId]`
citation — moving it, destroying it or giving it a placement requires a
`setSetting` for that place in the same resolution. Rewrite the whole
setting, preserving every still-true citation and removing the stale one. A
loose thing is never cited and never needs it.
