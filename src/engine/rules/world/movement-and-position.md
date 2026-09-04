# Movement and Position

This module governs travel between places, non-travel displacement, vehicles
and a character's position within a place.

## Actor-owned routes

`movement.route` grounds the route the actor stated into place ids. It is an
ordered list of waypoints and its last entry is the stated destination.

- Never invent an unstated leg or replace the actor's route with a better one.
- Every deliberate traversal along the world's connected ways requires
  `movement`, including one step into an adjacent room. One adjacent waypoint
  is a complete route. Forced or discontinuous displacement follows the rules
  below instead.
- Do not compute or output travel duration. Code derives it from the route and
  mode of travel.
- Do not reject or shorten a stated route because an edge appears blocked.
  Code validates adjacency and the movement runtime stops the traveller when a
  blocked edge is actually reached.
- `exitsFromHere` is code's authoritative view of the actor's immediate exits.
  A blocked edge closes that passage, not every place whose name appears in it.
- An invalid hop fails back to the actor with the two places that do not join.
  The Engine does not silently repair the route.

Time passing is not displacement. An outcome or occurrence must not place a
character's hands on an entity their applied position cannot reach.

## Blocked passages

A blocked passage is a world fact with a reason. Three writers set and clear
it: the weather engine closes passages the weather makes impassable, a
scripted event floods a ford, and you close a door someone barricades. One
flag per passage; the last write wins, and any writer may clear what another
set.

Code stops a walker at a blocked passage the moment their route reaches it
and hands you the interruption. Never pre-judge a stated route against the
blocked list. The actor learns the passage is shut, and their next command is
where the judgement happens:

- The act REMOVES the obstacle (the barricade broken down, the tree dragged
  aside): emit `sceneChanges connectionBlock {blocked:false}` and no
  `passBlockedConnectionId`. The passage is open for everyone.
- The act GETS THIS PERSON THROUGH while the obstacle stays (climbing the
  tree, wading the ford, pushing on through the blizzard): set
  `movement.passBlockedConnectionId` to the exact blocked `connectionId` from
  `exitsFromHere`. The passage stays blocked for everyone else; the runtime
  consumes this grant at that edge only, and checks every later edge normally.
  Use this only when passage can be decided directly; never combine it with
  a `check`, whose result is not known while the action is starting.
- The obstacle stops them: neither. The runtime interrupts the walk again and
  the actor is told why.

Never both for one passage in one resolution. `passBlockedConnectionId`
grants no route; it only applies to a matching edge in the actor-stated route.

## Non-travel displacement

Use `character.position` only when a body changes scenes without following a
travel route, for example:

- boarding or leaving a vehicle;
- being hit by a vehicle, explosion or creature and thrown elsewhere;
- being pushed down stairs, carried, dragged or knocked through an opening;
- falling through a floor, jumping from a height or vaulting directly through
  a window.

Walking, running, sneaking, riding or crawling to another place always uses
`movement.route`; never assign a road position through `character.position`.

The distinction is causal rather than voluntary versus involuntary alone:

- Ordinary locomotion through connected places uses `movement.route`.
- A direct action or external force that relocates the body without traversing
  that route uses `character.position`.
- If the character remains in the same scene but is displaced within it, keep
  their scene position and change `character.spot` instead.

Use the final resolved resting place, not a speculative point along the
flight. Do not emit both `movement.route` and `character.position` for the same
leg merely to make the displacement look more detailed.

## Displacement consequences

Position answers only where the character ends up. Resolve the other effects
independently and combine them when the evidence supports them:

- `character.position` or `character.spot` records the landing place;
- `character.hp` records impact injury, using a real deterministic damage roll
  whenever damage is rolled;
- `character.addCondition` records only a persistent, objectively verifiable
  major impairment such as unconsciousness or a fracture preventing use;
- an occurrence records the collision, fall, shove or throw and everyone able
  to perceive it.

Being moved does not imply injury, and injury does not imply relocation. A
minor shove may change only `spot`; a vehicle strike may change position, HP
and condition together; an impact against an immovable barrier may cause
damage without changing position.

When one actor displaces another, source the position and associated changes
to the action that applied the force. The displaced character does not need to
have chosen or issued a movement action.

## Vehicles

A vehicle has an exterior presence and an interior scene. Occupants stay in
the interior scene while the vehicle moves.

- Boarding and leaving use `character.position` into or out of the interior.
- Driving uses `movement.vehicleId` together with the actor-stated route.
- The driver must be inside the vehicle when driving begins.
- Only code determines route time and whether each road supports the vehicle.
- Permission and practical ability to drive—keys, condition, ownership and
  declared skill—remain part of Engine adjudication.

## Spots within a place

`character.spot` is a short phrase describing where someone is inside their
current place, such as "at the workbench, back to the door".

- Set it when an action leaves the character somewhere spatially distinct:
  seated, in cover, at a window or between two people.
- An empty string clears it.
- A spot persists until replaced or cleared by a location change.
- When a resolved arrival leaves someone in a new scene, set their arrival spot
  in the same resolution when the room can distinguish it.
