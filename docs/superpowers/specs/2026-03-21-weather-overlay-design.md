# Weather Overlay Animation — Design Spec

## Overview

Add a full-screen weather animation overlay to the simulation page combining **concrete weather objects** (sun, clouds) at specific positions with **full-screen particle/atmosphere effects** (rain, snow, fog, heat distortion). Realistic semi-transparent visual style. The overlay sits above all UI with `pointer-events: none`. Weather transitions use a 1.5s cross-fade.

## Architecture

### Z-Index Layering

```
z-index   0 — Phaser map canvas (.sim-canvas-layer)
z-index   2 — Popup backdrop (.sim-popup-backdrop)
z-index   5 — Loading/Error overlays (.sim-overlay)
z-index  10 — Header (.sim-header)
z-index  15 — Sidebar backdrop (.sim-sidebar-backdrop)
z-index  20 — Sidebar (.sim-sidebar)
z-index  30 — Scene popup (.sim-scene-popup)
z-index  50 — WeatherOverlay (full-screen, pointer-events: none)
```

Overlay at `z-index: 50` above everything. `pointer-events: none` for interaction passthrough.

### Component

Single file: `client/src/components/simulation/WeatherOverlay.tsx`

```tsx
type WeatherType = "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";

<WeatherOverlay weather={state.weather as WeatherType} />
```

Placed in `SimulationPage.tsx` immediately after the `.sim-canvas-layer` div, before the loading/error overlay.

### Internal Structure

Fixed full-screen container with two independent layers (A/B) for cross-fade transitions. Each layer contains:

- Its own `<canvas>` for particle effects (rain, snow, storm, extreme_cold)
- CSS divs for atmosphere effects (fog layers, color overlays, frost)
- CSS/SVG elements for concrete weather objects (sun, clouds)

A single `requestAnimationFrame` loop drives active canvases. Each layer is fully independent so cross-fades work without conflict.

### Canvas Sizing

DPR-aware for Retina displays:

```typescript
const dpr = window.devicePixelRatio || 1;
canvas.width = window.innerWidth * dpr;
canvas.height = window.innerHeight * dpr;
ctx.scale(dpr, dpr);
```

Debounced `resize` listener updates dimensions.

## Weather Effects

### clear — Sun + Tyndall Light

**Concrete element:**
- Semi-transparent sun in the **top-left corner** (~120px diameter)
- Radial gradient: bright white center → warm yellow → transparent edge
- Subtle pulsing glow animation (CSS `@keyframes`, scale 1.0–1.05, opacity oscillation)

**Full-screen effect:**
- Tyndall light rays: 3-5 diagonal semi-transparent gradient beams radiating from the sun position downward-right
- Each beam: narrow top, wider bottom, `rgba(255, 240, 200, 0.06–0.12)`, slight CSS sway animation at different speeds
- Faint warm tint on the overall page: `rgba(255, 245, 220, 0.03)`

### rain — Dark Clouds + Rain

**Concrete element:**
- Dark cloud cluster along the **top of the page, spanning the header area**
- Built from 3-5 overlapping CSS ellipses with `border-radius: 50%`, dark gray gradients (`rgba(60, 65, 75, 0.7)` to `rgba(40, 45, 55, 0.5)`)
- Subtle horizontal drift animation (CSS `translateX` sway, 15-20s cycle)

**Full-screen effect:**
- Canvas rain: ~200 raindrops
- Thin diagonal lines, white-blue (`rgba(174, 194, 224, 0.5)`), length 15-30px, width 1-2px
- Fall at ~70-degree angle, speed 8-14px/frame
- Slight overall darkening: `rgba(0, 0, 0, 0.08)` overlay

### snow — Gray Clouds + Snowfall

**Concrete element:**
- Lighter gray-white cloud cluster at the **top of the page**
- Similar to rain clouds but lighter: `rgba(180, 185, 195, 0.6)` to `rgba(200, 205, 215, 0.4)`
- Gentle horizontal drift

**Full-screen effect:**
- Canvas snow: ~150 snowflakes
- White filled circles, radius 1-4px, opacity 0.5-1.0
- Slow vertical fall (1-3px/frame), `sin(time + offset)` horizontal sway
- Depth: larger flakes fall faster and more opaque

### storm — Heavy Dark Clouds + Lightning + Downpour

**Concrete element:**
- Large, dense dark cloud mass covering **most of the top 15-20% of the viewport**
- Very dark gradients: `rgba(30, 35, 45, 0.8)` to `rgba(20, 25, 35, 0.6)`
- Slow internal movement (darker patches shifting within the cloud via animated gradient positions)

**Full-screen effect:**
- Canvas rain: ~400 dense raindrops, steeper angle, faster (12-20px/frame)
- Overall darkening: `rgba(0, 0, 0, 0.25)` overlay
- Lightning: random flashes every 3-8 seconds
  1. Full-screen white overlay at `rgba(255, 255, 255, 0.7)` for 80ms
  2. Fade to transparent over 200ms
  3. Optional double-flash (second at 0.4 opacity, 150ms after first)
- All lightning timers cancelled on weather change; in-progress flashes reset immediately

### fog — Drifting Fog Layers

**Concrete element:** None

**Full-screen effect:**
- 3 overlapping CSS divs with large radial/linear gradients in white/light-gray, opacity 0.3-0.5
- Each layer drifts horizontally at different speeds (CSS `@keyframes`):
  - Layer 1: 20s left-to-right
  - Layer 2: 30s right-to-left
  - Layer 3: 25s left-to-right
- `backdrop-filter: blur(1px)` for atmospheric softness

### extreme_heat — Intense Sun + Heat Distortion

**Concrete element:**
- Larger, more intense sun in the **top-left corner** (~160px diameter)
- Brighter radial gradient: white-hot center → intense orange → transparent
- Stronger pulsing glow, slightly faster than clear-weather sun

**Full-screen effect:**
- SVG filter heat distortion: `feTurbulence` + `feDisplacementMap`
  ```xml
  <filter id="heat-distortion">
    <feTurbulence type="turbulence" baseFrequency="0.01 0.03" numOctaves="3" />
    <feDisplacementMap in="SourceGraphic" scale="12" />
  </filter>
  ```
  Animate via CSS `@keyframes` transform (slow vertical translate) on the filtered div for smooth shimmer. Do NOT animate `seed` (causes jarring jumps).
- Warm color overlay: `rgba(255, 140, 0, 0.08)`
- Rising heat streaks: subtle upward-moving transparent gradient bands (CSS keyframes)

### extreme_cold — Frost + Light Snow

**Concrete element:** None

**Full-screen effect:**
- Cool blue tint: `rgba(100, 150, 220, 0.12)`
- Frost border: `box-shadow: inset 0 0 80px 40px rgba(200, 220, 255, 0.3)` — transparent center, icy edges
- White vignette at viewport edges
- Light snowfall: ~50 small slow particles via Canvas

## Transition System

When `weather` prop changes:

1. Current effect continues on outgoing layer
2. New effect starts on incoming layer at `opacity: 0`
3. CSS `transition: opacity 1.5s ease`:
   - Outgoing: `1 → 0`
   - Incoming: `0 → 1`
4. After 1.5s (`onTransitionEnd`): outgoing layer fully unmounted — canvas removed, timers cancelled
5. Transition to `clear`: fade out current, render nothing on incoming

Internal state: `currentWeather`, `prevWeather`, `transitioning` flag.

## Accessibility

Respect `prefers-reduced-motion`:

- Disable particle animation (static tint overlays only)
- Skip lightning flashes
- Disable heat distortion animation
- Sun/clouds render but without pulsing/drift animation

## Performance

- 1-2 canvases active at any time (only during transition)
- Moderate particle counts (50-400)
- SVG filter GPU-accelerated
- `pointer-events: none` on container
- `will-change: opacity` on transition layers
- Cleanup via `useEffect` on unmount and weather change
- Debounced resize handler

## Data Flow

```
SimulationRunner (backend)
  → npc_position_snapshot event data.weather
    → useSimulationState hook (state.weather)
      → SimulationPage → <WeatherOverlay weather={...} />
```

## File

`client/src/components/simulation/WeatherOverlay.tsx` — single file with all effects, particles, SVG filters, concrete elements, transitions, and accessibility.
