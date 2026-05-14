# Snow Avalanche Effect Design

## Summary

Add snow avalanche behavior to the existing weather overlay: when snow accumulates past a threshold on an obstacle's top surface, a chunk of snow detaches and falls to the bottom of the screen. The chunk initially falls as a solid piece, then mid-fall breaks apart into smaller fragments that continue falling until they exit the viewport.

Applies to both `snow` and `extreme_cold_snow` canvas layer types (both accumulate snow caps in the existing code).

## Context

The current `WeatherOverlay.tsx` snow system has:
- `Particle` objects that fall and sway
- `WeatherObstacle` detection via `data-weather-obstacle` DOM elements
- `SnowCap` height arrays that track accumulation on each obstacle's top surface
- `depositSnow` / `settleSnowCap` for accumulation and smoothing
- `maxDepth` cap per obstacle (24% of height, max 28px)
- `reducedMotion` guard: `CanvasLayer` returns `null` when active — avalanche inherits this (no special handling needed)
- `TransitionLayer` crossfade on weather change: outgoing `CanvasLayer` fades out over 1.5s with its own refs — in-flight chunks finish naturally during fade-out

Missing: no mechanism for snow to detach and fall when accumulation is heavy.

## Data Structures

### SnowChunk

Represents a detached piece of snow falling from an obstacle. Positions are absolute screen coordinates at spawn time and are not re-anchored if the source obstacle moves.

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

Scan every obstacle's `SnowCap` for contiguous segments where `height >= AVALANCHE_THRESHOLD_RATIO * snowCap.maxDepth`. To avoid unnecessary per-frame work, run the scan every 4th frame (~66ms at 60fps) — accumulation is gradual enough that this is visually indistinguishable from per-frame scanning.

If a single obstacle has multiple separate contiguous regions above threshold in the same frame, each region spawns its own chunk (subject to the global `MAX_SNOW_CHUNKS` cap and per-obstacle cooldown).

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
- Rendered as an irregular rounded rectangle via `quadraticCurveTo`, filled with `rgba(240, 248, 255, opacity)`, light shadow (`shadowBlur: 4`, reset to 0 after drawing)

### Shatter Transition (age === breakAge)

- Generate 3-5 `SnowFragment` objects:
  - Position: spread around chunk center
  - `vx`: random in [-1.5, 1.5]
  - `vy`: inherited from chunk `vy` + random offset [-0.5, 0.5]
  - `radius`: random 1-3px
  - `opacity`: 0.8
- On the transition frame, the solid chunk shape is still drawn (to avoid a single-frame pop), and fragments begin rendering from the next frame

### Fragment Phase (age > breakAge)

- Each fragment updates independently:
  - `x += vx`, `y += vy`, `vy += 0.1` (lighter gravity)
  - `opacity -= 0.003`
- Rendered as small circles with solid `fillStyle` (not radial gradients — fragments are 1-3px, solid fill is visually indistinguishable and cheaper)

### Removal

A chunk is removed when:
- `y > screenHeight` (fell off screen), OR
- All fragments have `opacity <= 0`

Falling chunks ignore other obstacles during their descent — no inter-obstacle collision. Horizontal sway is ±0.3px amplitude, so horizontal screen exit is not a concern and is not checked.

## Function Signatures

```typescript
function trySpawnSnowChunks(
  obstacles: WeatherObstacle[],
  snowCaps: Record<string, SnowCap>,
  chunks: SnowChunk[],
  cooldowns: Record<string, number>  // obstacleId → remaining cooldown frames
): void;

function updateAndDrawSnowChunks(
  ctx: CanvasRenderingContext2D,
  chunks: SnowChunk[],
  screenHeight: number
): void;

function drawChunkShape(
  ctx: CanvasRenderingContext2D,
  chunk: SnowChunk
): void;

function drawChunkFragments(
  ctx: CanvasRenderingContext2D,
  chunk: SnowChunk
): void;
```

`trySpawnSnowChunks` mutates `snowCaps` (reduces heights), `chunks` (pushes new entries), and `cooldowns` (sets/decrements values). `updateAndDrawSnowChunks` mutates `chunks` in-place (updates positions, removes dead chunks).

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
| `draw` callback, snow branch | Call `trySpawnSnowChunks` **before** `drawSnowCaps`, then `updateAndDrawSnowChunks` **after** `drawSnowCaps` (spawn reduces cap heights before they are drawn; chunks render on top of caps) |
| `resize` function | Reset `snowChunksRef.current = []` and `cooldownsRef.current = {}` |

### Untouched

All existing functions: `Particle`, `SnowCap`, `depositSnow`, `settleSnowCap`, `findSnowImpact`, `drawSnowCaps`, `ensureSnowCaps`, `respawnSnowParticle`, `initSnowParticles`.

## Constants

| Name | Value | Rationale |
|------|-------|-----------|
| `AVALANCHE_THRESHOLD_RATIO` | `0.75` | Effective threshold = ratio * snowCap.maxDepth; triggers before absolute cap |
| `AVALANCHE_COOLDOWN` | 120 frames (~2s) | Prevents rapid-fire detachments on same obstacle |
| `AVALANCHE_SCAN_INTERVAL` | 4 frames | Scan every 4th frame to reduce cost; accumulation is gradual |
| `MAX_SNOW_CHUNKS` | 15 | Performance ceiling |
| `CHUNK_BREAK_AGE_MIN` | 40 | ~0.7s of solid fall |
| `CHUNK_BREAK_AGE_MAX` | 70 | ~1.2s of solid fall |
| `CHUNK_GRAVITY` | 0.12 | Acceleration per frame |
| `FRAGMENT_GRAVITY` | 0.1 | Lighter than chunk |
| `FRAGMENT_COUNT_MIN` | 3 | Min fragments on shatter |
| `FRAGMENT_COUNT_MAX` | 5 | Max fragments on shatter |
| `HEIGHT_REDUCTION` | 0.5 | Retain 50% base snow after detachment |

## Notes

- All velocities are per-frame, not per-second. This matches the existing rain/snow particle system. Delta-time correction is out of scope.
- Frame-rate drops (e.g., background tab throttling) will slow chunk animation proportionally — consistent with how existing particles behave.
