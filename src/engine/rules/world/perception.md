# Perception and Audience Resolution

This module decides which characters receive each objective occurrence and how
much of that occurrence reaches them. Perception is evidence routing, not
narration: the Engine determines the audience and the objective information
available to that audience; the Renderer later turns that information into a
character's sensory prose.

## Evidence available to the Engine

Base every perception decision on the request already provided:

- `Characters`: each character's `locationId`, exact `position`, optional
  `spot` and current conditions, together with their entries under `New
  Commands` or `Active Actions`;
- `Detailed Places`: whether a place is indoors, its description, conditions,
  connections, present characters and current environment reading;
- `World Graph` and `Blocked Connections`: macro geography, adjacency,
  passages, road travel distance and current barriers;
- `Items` and `Vehicles`: physical holders, hidden state, vehicle position and
  the vehicle's separate interior scene;
- the specific action: actor, description, `objectRefs`, utterance, declared
  skill, elapsed phase and deterministic dice result;
- objective events and the world changes being settled in this resolution.

There is no perception lookup tool. Do not spend a tool turn asking for
information already in the request, and do not invent missing geometry,
distances, openings or sensory capabilities. When the evidence cannot carry a
fact to a remote character, exclude that character.

## The required decision sequence

For every perceptible moment, make the following decisions in order.

### 1. Establish the event and its sources

Identify what objectively happens, when it happens, and every place from which
its sensory evidence originates. Use the actual resolved action, not the
actor's hoped-for result.

- A spoken line originates where the speaker is when it is delivered.
- A gunshot has evidence at the weapon, along its visible line of fire where
  supported, and at an impact that actually occurs.
- A fall or forced displacement can have a departure event, a passage event
  and a landing event in different places.
- A vehicle collision has evidence outside at the collision and directly
  inside the vehicle for its occupants.
- A discovered clue originates at the object or place where it was uncovered;
  the searcher's private understanding is not a sensory event.

When an action changes location, distinguish the actor's position before the
change from the final resolved position. Do not pretend the whole event occurred
only at the destination.

### 2. Build candidate perceivers from geography

Start with characters who have a physically supported route for evidence:

1. the actor and anyone directly acted upon;
2. characters in the same exact scene or on the same road segment;
3. characters at an event's other physical endpoint, such as the landing place
   or the interior of a struck vehicle;
4. characters in an explicitly connected neighbouring place when the passage
   and event could carry the relevant sense;
5. more distant characters only for an unusually strong event or an explicit
   transmission mechanism supported by the action and geography.

Co-location makes someone a candidate, not an automatic perceiver. Conversely,
being named in `targetIds` or `objectRefs` does not prove perception. A target
may be absent, a bystander may be better placed than the target, and an actor
may be unconscious or otherwise unaware of what happens to them.

Scene ids are exact. Two rooms in one building, two floors, a vehicle cabin and
its exterior, or a road and a building beside it are not the same sensory
space merely because they share a parent location. Use explicit connections
and descriptions to determine what lies between them.

For characters on a road, compare the numeric 0-1 positions and the road's
full travel time. Sharing a road id makes them candidates, but characters near
opposite ends of a long road are not nearby witnesses.

### 3. Derive the action's sensory signature

Judge the concrete action rather than its broad category. Determine what it
actually produces in each relevant sense:

- **Vision:** body movement, visible contact, exposed objects, light, smoke,
  damage, a projectile or a change of position.
- **Hearing:** intelligible words, footsteps, machinery, impact, breaking
  material, an alarm, gunfire or an explosion.
- **Touch and proprioception:** contact with the body, recoil, restraint,
  carried motion, vehicle motion, injury and one's own physical action.
- **Smell and air:** smoke, fuel, chemicals, blood or another source the input
  objectively establishes.
- **Instrumental transmission:** a telephone, radio, alarm circuit, camera or
  similar item only when the action and item establish that it is operating and
  connected to the recipient.

Do not give every action every modality. Reading silently is not audible;
speaking behind a wall is not visible; a hidden pickpocketing success may leave
no external trace; an internal decision has no audience without observable
conduct.

### 4. Apply the environment and barriers

Modify each candidate's access using the event place, observer place and what
lies between them.

#### Sight

- Illumination uses the supplied 1-5 scale: 1 is pitch black, 2 dark, 3 normal,
  4 bright and 5 blinding. Darkness removes fine detail before it removes a
  large silhouette or nearby light; glare can also erase detail.
- Fog, smoke, rain, airborne hazards, cover, crowds and scene conditions limit
  contrast and range when the input says they are present.
- Walls, floors, closed containers and opaque vehicle bodies block sight. A
  door, window, opening, mirror or line described in the scene may permit only
  the view it physically supports.
- A hidden item is not visible until the action exposes or reveals it. Engine
  knowledge of a hidden entity is not observer knowledge.
- `spot` constrains facing, cover and proximity qualitatively. It is not a
  measured coordinate and must not be converted into invented metres.

#### Hearing

- Compare the concrete sound with the supplied ambient `noise` and named scene
  conditions. A higher noise reading masks quiet detail before it masks a loud
  impact, alarm, gunshot or explosion.
- Words require intelligibility, not mere audibility. A listener may hear that
  someone spoke without receiving the utterance.
- Walls, floors, distance, weather, closed doors and vehicle bodies attenuate
  sound. An opening or thin partition may pass it. A blocked passage is not
  automatically soundproof, and an open connection is not automatically within
  conversational earshot; use its description and the action's volume.
- Do not propagate ordinary sound across multiple graph edges without explicit
  evidence. Exceptionally loud events may produce progressively coarser traces,
  but topology alone never proves that they do.

#### Smell, air and temperature

- Smell and airborne material normally begin in the source place. Carry them
  into another place only when an opening, airflow, shared exterior or explicit
  spread supports it.
- `airborneHazards`, oxygen and temperature describe the current local
  environment. They may affect whether a local character can remain alert or
  what local change they perceive, but they do not broadcast an unrelated
  action to distant characters.
- Do not invent poisoning, suffocation, unconsciousness or sensory loss from a
  number alone; use supplied conditions and resolved consequences.

#### Character capability and attention

- Apply blindness, deafness, unconsciousness, restraint, severe impairment and
  other explicit conditions to the relevant senses.
- A character's current action and `spot` may cause a subtle cue to be missed.
  They do not erase an unavoidable cue such as bodily contact, a nearby blast
  or the motion of a vehicle carrying them.
- Never use occupation, skills or attributes to grant supernatural senses.
  Those fields may support the objective result of a resolved investigation or
  knowledge action only after sensory evidence actually reaches the actor.

### 5. Assign an information grade

Classify each candidate separately. The grade IS output: it is the `clarity`
on that character's entry in the occurrence's `perceivers` list.

- **`full`** (direct): the character receives the event and its relevant
  detail. Examples: bodily contact; a clear nearby view; intelligible words;
  the searcher reading the clue they uncovered.
- **`limited`** (clear but partial): the character knows the kind of event and
  its immediate result but lacks fine detail. Examples: a struggle seen through
  a dirty window without the small object exchanged; a machine heard starting
  through a wall without seeing who touched it; a speaker seen or recognised
  whose words do not carry.
- **`trace`**: the character receives only that something happened, with no
  source, cause, actor or fine result. Examples: a muffled impact upstairs, a
  flash beyond the fog, an indistinct voice whose source cannot be placed.
- **None:** no supported sensory evidence reaches the character. They are not
  listed on the occurrence at all.

Never upgrade a grade by filling gaps with omniscient world knowledge. A trace
of a gunshot is not knowledge of the shooter, target, weapon or result. A clear
view of a face is physical detail, not automatic knowledge of the person's
canonical identity; downstream identity rules decide how that person is named.

## Encode the audience

One occurrence row per objective fact. The row carries the fact once and lists
everyone who received any evidence of it:

- `perceivers` lists every character with any supported evidence of this
  fact, one entry per character, each as `{ characterId, clarity }` with
  `clarity` set to that character's grade from step 5. Not every nearby
  character and not every action participant — only those the evidence reached.
- Write `content` at FULL objective detail regardless of who is listed. Never
  write it down to the lowest shared grade; the Renderer degrades what each
  perceiver receives according to their `clarity`.
- Split rows ONLY when audiences receive different FACTS (the shove in one
  room, the landing in the courtyard), citing the same `actionIds`. Never split
  a single fact by degree — different degrees of one fact are one row, graded
  per perceiver.
- Keep `content` objective and third-person. Describe the available evidence,
  not what a character thinks, infers, remembers, recognizes or feels.
- Do not output sensory channels, locations, actors, signals or fact arrays.
  `clarity` is the only perception field; code derives the structural fields
  from the cited actions.

### Speech encoding

- One `speech:true` row per utterance delivered this tick — an id under
  `endingWithUtterance`, and no other. A starting action's words are not yet
  said: it takes no occurrence. Code copies the command's utterance verbatim
  onto the row; never restate the words in `content`.
- Everyone who heard or saw the speaking at all is listed on that one row:
  - made out the words → `full`;
  - knows who spoke but not the words (the watched whisper, the recognised
    voice through a door) → `limited`;
  - an indistinct voice through a wall, source unplaceable → `trace`.
- There is no separate `speech:false` onlooker row for a speech act.
- Addressed characters (`targetIds`) and receivers (`perceivers`) remain
  separate sets.
- The speaker normally hears their own words, but explicit unconsciousness,
  sensory loss or another supported condition may prevent it.

## Action-specific applications

- **Stealth and concealment:** respect the declared skill result and its skill
  guidance. A successful unnoticed act does not place the avoided observer in
  the audience. A failed or fumbled act exposes only the trace the observer was
  physically able to receive.
- **Search and investigation:** the searcher directly receives a discovered
  detail. A nearby watcher may see the search being performed without learning
  the clue, text or inference. Sharing it requires speech or an observable
  display.
- **Melee, restraint and medical contact:** actor and touched target receive
  direct bodily evidence even in poor light. Bystanders receive only what their
  view and hearing support. Injury does not reveal an unseen cause by itself.
- **Ranged attacks:** separate muzzle event, flight where genuinely visible or
  audible, and impact. Someone who hears a shot but cannot see either endpoint
  is listed on the shot row at `trace`.
- **Forced movement and falls:** source observers may see departure, destination
  observers may see or hear landing, and the displaced character receives
  direct motion and impact unless awareness is explicitly absent. These are
  different facts: give each its own row when the audiences differ.
- **Items and transfers:** holders and direct recipients feel a transfer;
  observers need a supported view. Contents of pockets, closed containers and
  concealed hands are not disclosed merely because the Engine knows them.
- **Vehicles:** occupants belong to the interior scene and perceive carried
  motion, abrupt acceleration and collision directly. Exterior observers need
  a supported view or sound. The cabin and exterior are never treated as one
  unobstructed room.
- **Internal, social and knowledge actions:** private thought, intent, belief
  and interpretation have no sensory audience. Others receive only issued
  words and observable conduct; they retain agency over their own reaction.

## Calibration examples

### Whisper in a crowded room

The whisper's action ends this tick (it is under `endingWithUtterance`). The
intended listener beside the speaker makes out the words; two people across
the noisy room see the speaker lean close but cannot hear them; someone in the
next room catches a voice through the wall without placing it.

- ONE `speech:true` row, `perceivers`: speaker and intended listener at
  `full`; the two watching onlookers at `limited` (they saw who leaned in to
  whom); the character through the wall at `trace`;
- no second row for the onlookers, and no paraphrase of the words in `content`.

### Gunshot behind a closed door

Characters in the room see and hear the shot and impact. Someone in the next
room hears a sharp report through the door but has no view. A character two
buildings away receives nothing unless the geography, environment or action
explicitly supports that reach.

- ONE row, `content` at full detail (who fired, at what, what it struck);
  `perceivers`: the room at `full`, the adjacent listener at `trace`;
- the unsupported distant character is not listed.

### Person pushed through a window

People in the source room can receive the shove and breaking window. People in
the courtyard can receive the body emerging and landing. The falling person
receives the force, fall and impact directly. These are still separate rows,
because the FACTS differ — not because the degrees do:

- one row for the shove and the breaking window, `perceivers`: the source room
  graded by their view, the falling person at `full`;
- one row for the body emerging and landing, `perceivers`: the courtyard graded
  by their view, the falling person at `full`;
- each row's `content` at full objective detail; each perceiver at the highest
  grade their evidence supports.

## Final audit

Before submitting each occurrence, verify:

1. What exact resolved action or objective event produced this evidence?
2. Where did each part originate, including departure and destination?
3. Which characters had a physically supported sensory route to it?
4. How did illumination, noise, weather, hazards, barriers, `spot`, vehicles
   and character conditions alter that route?
5. Is every character with any supported evidence listed, and nobody without?
6. Does every perceiver carry the highest `clarity` the evidence supports, and
   nobody a higher one?
7. Are rows split only where the facts differ, and is each `content` complete
   and objective at full detail?
8. Are target, participant and perceiver sets being kept distinct?
9. Is the content objective, with no hidden fact, unsupported identity claim,
   private interpretation, emotion or unissued reaction?
10. On a speech row, is the cited action under `endingWithUtterance` — does it
    end this tick? A starting action's words are not said yet.
11. On a speech row, is `full` given only to those who made out the words?
