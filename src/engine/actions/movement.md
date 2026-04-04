# Movement

## Skill Check
- skill: (optional, e.g. Stealth, Climb — only for creative movement)
- difficulty: regular
- type: single
- failBehavior: abort

## State Changes

### On Success
#### character
- Position updated to destination
- fatigue: +1 (if long distance)
- memory: "Traveled to [destination]"

### On Failure
#### character
- Position unchanged
- memory: "Tried to reach [destination] but failed"
