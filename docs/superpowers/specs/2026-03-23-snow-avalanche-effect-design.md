# Snow Avalanche Effect Design

## Summary

Add snow avalanche behavior to the existing weather overlay: when snow accumulates past a threshold on an obstacle's top surface, a chunk of snow detaches and falls to the bottom of the screen. The chunk initially falls as a solid piece, then mid-fall breaks apart into smaller fragments that continue falling until they exit the viewport.

## Context

The current `WeatherOverlay.tsx` snow system has:
- `Particle` objects that fall and sway
- `WeatherObstacle` detection via `data-weather-obstacle` DOM elements
- `SnowCap` height arrays that track accumulation on each obstacle's top surface
- `depositSnow` / `settleSnowCap` for accumulation and smoothing
- `maxDepth` cap per obstacle (24% of height, max 28px)

Missing: no mechanism for snow to detach and fall when accumulation is heavy.

## Data Structures

### SnowChunk

Represents a detached piece of snow falling from an obstacle.

```typescript
interface SnowChunk {
  x: number;           // horizontal center of the chunk
  y: number;           // current vertical position
  width: number;       // chunk width (10-40px, based on contiguous region)
  height: number;      // chunk height (average snow depth at detachment)
  vy: number;          // vertical velocity (gravity-accelerated)
  age: number;         // frame counter since spawn
  breakAge: number;    // frame at which chunk shatters (random 40-70)
  opacity: number;     // opacity for the solid phase
  fragments: SnowFragment[];  // child particles after shattering
}
```

### SnowFragment

A small particle produced when a SnowChunk shatters.

```typescript
interface SnowFragment {
  x: number;
  y: number;
  vx: number;          // horizontal spread velocity
  vy: number;          // vertical velocity (inherited + random)
  radius: number;      // 1-3px
  opacity: number;     // starts ~0.8, decays over time
}
```

## Trigger Logic

### Detection

Each frame, scan every obstacle's `SnowCap` for contiguous segments where `height >= maxDepth * 0.75`.

### Spawn

When a contiguous region is found:
1. Compute the center x and width of the region
2. Compute the average snow depth across the region
3. Create a `SnowChunk` at `(centerX, obstacle.top - avgDepth)` with:
   - `width` = region width, clamped to 10-40px
   - `height` = average depth of the region
   - `vy = 0.5` (slow initial fall)
   - `breakAge` = random integer in [40, 70]
   - `fragments = []`
4. Reduce the snow cap heights in the region by 50% (retain a base layer)

### Frequency Control

- Per-obstacle cooldown: 120 frames (~2 seconds) after a detachment before the same obstacle can trigger again
- Global cap: maximum 15 simultaneous `SnowChunk` objects

## Animation

### Solid Phase (age < breakAge)

- `y += vy`, `vy += 0.12` (gravity)
- Gentle horizontal sway: `x += sin(age * 0.08) * 0.3`
- Opacity slowly decays: `opacity *= 0.997`
- Rendered as an irregular rounded rectangle via `quadraticCurveTo`, filled with `rgba(240, 248, 255, opacity)`, light shadow (`shadowBlur: 4`)

### Shatter Transition (age === breakAge)

- Generate 3-5 `SnowFragment` objects:
  - Position: spread around chunk center
  - `vx`: random in [-1.5, 1.5]
  - `vy`: inherited from chunk `vy` + random offset [-0.5, 0.5]
  - `radius`: random 1-3px
  - `opacity`: 0.8

### Fragment Phase (age > breakAge)

- Each fragment updates independently:
  - `x += vx`, `y += vy`, `vy += 0.1` (lighter gravity)
  - `opacity -= 0.003`
- Rendered as small circles with radial gradients (matching existing snow particle style)

### Removal

A chunk is removed when:
- `y > screenHeight` (fell off screen), OR
- All fragments have `opacity <= 0`

## Integration Points

All changes are in `WeatherOverlay.tsx`.

### New code (does not modify existing functions)

| Item | Description |
|------|-------------|
| `SnowChunk`, `SnowFragment` interfaces | Data types, near existing `SnowCap` |
| `trySpawnSnowChunks()` | Scans caps, spawns chunks, reduces heights, manages cooldowns |
| `updateAndDrawSnowChunks()` | Per-frame update + render for all chunks |
| `drawChunkShape()` | Renders the solid-phase irregular shape |
| `drawChunkFragments()` | Renders fragment-phase particles |

### Modified code (minimal)

| Location | Change |
|----------|--------|
| `CanvasLayer` refs | Add `snowChunksRef`, `cooldownsRef` |
| `draw` callback, snow branch | Call `trySpawnSnowChunks` + `updateAndDrawSnowChunks` after `drawSnowCaps` |
| `resize` function | Reset `snowChunksRef.current = []` |

### Untouched

All existing functions: `Particle`, `SnowCap`, `depositSnow`, `settleSnowCap`, `findSnowImpact`, `drawSnowCaps`, `ensureSnowCaps`, `respawnSnowParticle`, `initSnowParticles`.

## Constants

| Name | Value | Rationale |
|------|-------|-----------|
| `AVALANCHE_THRESHOLD` | `0.75 * maxDepth` | Triggers before absolute cap, feels natural |
| `AVALANCHE_COOLDOWN` | 120 frames (~2s) | Prevents rapid-fire detachments on same obstacle |
| `MAX_SNOW_CHUNKS` | 15 | Performance ceiling |
| `CHUNK_BREAK_AGE_MIN` | 40 | ~0.7s of solid fall |
| `CHUNK_BREAK_AGE_MAX` | 70 | ~1.2s of solid fall |
| `CHUNK_GRAVITY` | 0.12 | Acceleration per frame |
| `FRAGMENT_GRAVITY` | 0.1 | Lighter than chunk |
| `FRAGMENT_COUNT_MIN` | 3 | Min fragments on shatter |
| `FRAGMENT_COUNT_MAX` | 5 | Max fragments on shatter |
| `HEIGHT_REDUCTION` | 0.5 | Retain 50% base snow after detachment |
