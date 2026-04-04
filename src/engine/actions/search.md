# Search

## Skill Check
- skill: Spot Hidden | Library Use | Perception
- difficulty: regular
- type: single
- failBehavior: partial

## State Changes

### On Success
#### item
- Discover hidden items in scene based on search context
- Reveal evidence items if present
#### scene
- Mark area as searched
#### character
- fatigue: +1
- memory: "Searched [location] and found [discoveries]"

### On Failure
#### scene
- Mark area as searched (nothing found)
#### character
- fatigue: +1
- memory: "Searched [location] but found nothing useful"
