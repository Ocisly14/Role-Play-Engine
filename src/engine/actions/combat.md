# Combat

## Skill Check
- skill: Fighting (Brawl) | Fighting (Melee) | Firearms
- difficulty: regular
- type: opposed
- opposedDefense: Dodge | Fighting (Brawl)
- failBehavior: abort

## State Changes

### On Success
#### character
- Target: HP reduced based on weapon damage and success level
- Target: may gain wound conditions (bleeding, bruised, broken bone)
- Actor: fatigue +1
- memory (actor): "Attacked [target] at [location]"
- memory (target): "Was attacked by [actor]"

### On Failure
#### character
- Actor: fatigue +1
- memory (actor): "Tried to attack [target] but missed"
- memory (target): "Saw [actor] attempt to attack me"

## Feature Overlay
- sanityDrain: (witnesses only, if violence is extreme)
