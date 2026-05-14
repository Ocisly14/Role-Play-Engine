# Snow Avalanche Effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add snow avalanche behavior — accumulated snow on obstacles detaches, falls as a chunk, shatters into fragments mid-air, and falls to the bottom of the screen.

**Architecture:** All changes are in `client/src/components/simulation/WeatherOverlay.tsx`. New interfaces (`SnowChunk`, `SnowFragment`) and pure functions are added alongside the existing snow cap system. Two new refs in `CanvasLayer` store chunk state. The draw loop calls spawn logic before `drawSnowCaps` and chunk rendering after it.

**Tech Stack:** React, HTML Canvas 2D, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-23-snow-avalanche-effect-design.md`

---

### File Map

- **Modify:** `client/src/components/simulation/WeatherOverlay.tsx`
  - Add interfaces after `SnowCap` (near line 73)
  - Add constants after `MAX_SPLASH_PARTICLES` (near line 84)
  - Add functions after `drawSnowCaps` (after line 487)
  - Add refs in `CanvasLayer` (after line 501)
  - Modify `draw` callback snow branch (around line 652)
  - Modify `resize` function (around line 691)

No new files. No test files (this is a visual canvas animation — verified by eye).

---

### Task 1: Add interfaces and constants

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx:73-84`

- [ ] **Step 1: Add `SnowChunk` and `SnowFragment` interfaces after `SnowCap`**

After the `SnowCap` interface (line 73), add:

```typescript
interface SnowChunk {
  x: number;
  y: number;
  width: number;
  height: number;
  vy: number;
  age: number;
  breakAge: number;
  opacity: number;
  fragments: SnowFragment[];
}

interface SnowFragment {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
}
```

- [ ] **Step 2: Add avalanche constants after `MAX_SPLASH_PARTICLES`**

After line 84 (`const MAX_SPLASH_PARTICLES = 220;`), add:

```typescript
const AVALANCHE_THRESHOLD_RATIO = 0.75;
const AVALANCHE_COOLDOWN = 120;
const AVALANCHE_SCAN_INTERVAL = 4;
const MAX_SNOW_CHUNKS = 15;
const CHUNK_BREAK_AGE_MIN = 40;
const CHUNK_BREAK_AGE_MAX = 70;
const CHUNK_GRAVITY = 0.12;
const FRAGMENT_GRAVITY = 0.1;
const FRAGMENT_COUNT_MIN = 3;
const FRAGMENT_COUNT_MAX = 5;
const HEIGHT_REDUCTION = 0.5;
```

- [ ] **Step 3: Verify no TypeScript errors**

Run: `cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors related to the new types/constants.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat(weather): add SnowChunk/SnowFragment interfaces and avalanche constants"
```

---

### Task 2: Implement `trySpawnSnowChunks`

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx` (add after `drawSnowCaps`, ~line 487)

- [ ] **Step 1: Add `trySpawnSnowChunks` function**

Place this after the `drawSnowCaps` function:

```typescript
function tickAvalancheCooldowns(
  cooldowns: Record<string, number>
): void {
  for (const id of Object.keys(cooldowns)) {
    cooldowns[id] -= 1;
    if (cooldowns[id] <= 0) {
      delete cooldowns[id];
    }
  }
}

function trySpawnSnowChunks(
  obstacles: WeatherObstacle[],
  snowCaps: Record<string, SnowCap>,
  chunks: SnowChunk[],
  cooldowns: Record<string, number>
): void {
  if (chunks.length >= MAX_SNOW_CHUNKS) return;

  for (const obstacle of obstacles) {
    if (cooldowns[obstacle.id] !== undefined) continue;

    const snowCap = snowCaps[obstacle.id];
    if (!snowCap) continue;

    const threshold = AVALANCHE_THRESHOLD_RATIO * snowCap.maxDepth;
    const heights = snowCap.heights;

    // Find contiguous regions above threshold — each region spawns a chunk
    let regionStart = -1;
    let spawned = false;
    for (let i = 0; i <= heights.length; i += 1) {
      const aboveThreshold = i < heights.length && heights[i] >= threshold;

      if (aboveThreshold && regionStart === -1) {
        regionStart = i;
      } else if (!aboveThreshold && regionStart !== -1) {
        // Region [regionStart, i) is above threshold
        const regionWidth = (i - regionStart) * snowCap.segmentWidth;
        const chunkWidth = clamp(regionWidth, 10, 40);

        let depthSum = 0;
        for (let j = regionStart; j < i; j += 1) {
          depthSum += heights[j];
        }
        const avgDepth = depthSum / (i - regionStart);

        const centerSegment = (regionStart + i - 1) / 2;
        const centerX =
          obstacle.left + centerSegment * snowCap.segmentWidth;

        chunks.push({
          x: centerX,
          y: obstacle.top - avgDepth,
          width: chunkWidth,
          height: avgDepth,
          vy: 0.5,
          age: 0,
          breakAge:
            CHUNK_BREAK_AGE_MIN +
            Math.floor(
              Math.random() * (CHUNK_BREAK_AGE_MAX - CHUNK_BREAK_AGE_MIN)
            ),
          opacity: 0.9,
          fragments: [],
        });

        // Reduce snow cap heights in region by 50%
        for (let j = regionStart; j < i; j += 1) {
          heights[j] *= HEIGHT_REDUCTION;
        }

        spawned = true;
        regionStart = -1;

        if (chunks.length >= MAX_SNOW_CHUNKS) return;
      }
    }

    // Apply cooldown only after spawning at least one chunk
    if (spawned) {
      cooldowns[obstacle.id] = AVALANCHE_COOLDOWN;
    }
  }
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat(weather): implement tickAvalancheCooldowns and trySpawnSnowChunks"
```

---

### Task 3: Implement chunk drawing functions

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx` (add after `trySpawnSnowChunks`)

- [ ] **Step 1: Add `drawChunkShape` function**

```typescript
function drawChunkShape(
  ctx: CanvasRenderingContext2D,
  chunk: SnowChunk
): void {
  const halfW = chunk.width / 2;
  const halfH = chunk.height / 2;
  const x = chunk.x;
  const y = chunk.y;

  ctx.save();
  ctx.shadowColor = "rgba(255,255,255,0.12)";
  ctx.shadowBlur = 4;
  ctx.fillStyle = `rgba(240,248,255,${chunk.opacity})`;

  ctx.beginPath();
  // Irregular rounded shape using quadratic curves
  ctx.moveTo(x - halfW * 0.8, y - halfH);
  ctx.quadraticCurveTo(x - halfW, y - halfH * 0.5, x - halfW, y);
  ctx.quadraticCurveTo(x - halfW * 0.9, y + halfH * 0.8, x - halfW * 0.3, y + halfH);
  ctx.quadraticCurveTo(x, y + halfH * 1.1, x + halfW * 0.4, y + halfH);
  ctx.quadraticCurveTo(x + halfW * 0.9, y + halfH * 0.7, x + halfW, y);
  ctx.quadraticCurveTo(x + halfW * 0.95, y - halfH * 0.6, x + halfW * 0.7, y - halfH);
  ctx.quadraticCurveTo(x, y - halfH * 1.1, x - halfW * 0.8, y - halfH);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
```

- [ ] **Step 2: Add `drawChunkFragments` function**

```typescript
function drawChunkFragments(
  ctx: CanvasRenderingContext2D,
  chunk: SnowChunk
): void {
  for (const f of chunk.fragments) {
    if (f.opacity <= 0) continue;
    ctx.fillStyle = `rgba(240,248,255,${f.opacity})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
```

- [ ] **Step 3: Verify no TypeScript errors**

Run: `cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat(weather): add drawChunkShape and drawChunkFragments rendering"
```

---

### Task 4: Implement `updateAndDrawSnowChunks`

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx` (add after drawing functions)

- [ ] **Step 1: Add `updateAndDrawSnowChunks` function**

```typescript
function updateAndDrawSnowChunks(
  ctx: CanvasRenderingContext2D,
  chunks: SnowChunk[],
  screenHeight: number
): void {
  let writeIndex = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    chunk.age += 1;
    chunk.y += chunk.vy;
    chunk.vy += CHUNK_GRAVITY;

    if (chunk.age < chunk.breakAge) {
      // Solid phase
      chunk.x += Math.sin(chunk.age * 0.08) * 0.3;
      chunk.opacity *= 0.997;
      drawChunkShape(ctx, chunk);
    } else if (chunk.age === chunk.breakAge) {
      // Shatter transition — draw solid shape one last time
      drawChunkShape(ctx, chunk);

      // Generate fragments
      const count =
        FRAGMENT_COUNT_MIN +
        Math.floor(Math.random() * (FRAGMENT_COUNT_MAX - FRAGMENT_COUNT_MIN + 1));
      for (let j = 0; j < count; j += 1) {
        chunk.fragments.push({
          x: chunk.x + (Math.random() - 0.5) * chunk.width,
          y: chunk.y + (Math.random() - 0.5) * chunk.height,
          vx: (Math.random() - 0.5) * 3,
          vy: chunk.vy + (Math.random() - 0.5),
          radius: 1 + Math.random() * 2,
          opacity: 0.8,
        });
      }
    } else {
      // Fragment phase
      let allDead = true;
      for (const f of chunk.fragments) {
        f.x += f.vx;
        f.y += f.vy;
        f.vy += FRAGMENT_GRAVITY;
        f.opacity -= 0.003;
        if (f.opacity > 0 && f.y <= screenHeight) {
          allDead = false;
        }
      }
      drawChunkFragments(ctx, chunk);

      if (allDead) continue; // Skip writing — effectively removes chunk
    }

    // Remove if below screen
    if (chunk.y > screenHeight + 20 && chunk.fragments.length === 0) {
      continue;
    }

    chunks[writeIndex] = chunk;
    writeIndex += 1;
  }

  chunks.length = writeIndex;
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat(weather): implement updateAndDrawSnowChunks animation loop"
```

---

### Task 5: Wire into CanvasLayer

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx:499-501,652,691`

- [ ] **Step 1: Add refs in `CanvasLayer`**

After `snowCapsRef` (line 499) and before `rafRef` (line 500), add:

```typescript
  const snowChunksRef = useRef<SnowChunk[]>([]);
  const cooldownsRef = useRef<Record<string, number>>({});
  const scanFrameRef = useRef(0);
```

- [ ] **Step 2: Insert spawn call before `drawSnowCaps` in the draw callback**

In the `draw` callback, in the snow `else` branch, just before `drawSnowCaps(ctx, obstacles, snowCapsRef.current);` (line 652), add:

```typescript
      // Avalanche: tick cooldowns every frame, scan for new chunks every Nth frame
      tickAvalancheCooldowns(cooldownsRef.current);
      scanFrameRef.current += 1;
      if (scanFrameRef.current >= AVALANCHE_SCAN_INTERVAL) {
        scanFrameRef.current = 0;
        trySpawnSnowChunks(
          obstacles,
          snowCapsRef.current,
          snowChunksRef.current,
          cooldownsRef.current
        );
      }
```

- [ ] **Step 3: Insert chunk rendering after `drawSnowCaps`**

Immediately after `drawSnowCaps(ctx, obstacles, snowCapsRef.current);` add:

```typescript
      updateAndDrawSnowChunks(ctx, snowChunksRef.current, h);
```

- [ ] **Step 4: Reset chunk state in resize function**

In the `resize` function, after `updateObstacles();` (line 691), add:

```typescript
      snowChunksRef.current = [];
      cooldownsRef.current = {};
      scanFrameRef.current = 0;
```

- [ ] **Step 5: Verify no TypeScript errors**

Run: `cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat(weather): wire snow avalanche into CanvasLayer draw loop"
```

---

### Task 6: Visual verification

- [ ] **Step 1: Build the client**

Run: `cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && pnpm build 2>&1 | tail -10`
Expected: Build succeeds with no errors.

- [ ] **Step 2: Manual visual test**

Start the dev server and switch weather to `snow`. Observe:
1. Snow accumulates on obstacles as before
2. When accumulation exceeds ~75% of max depth, a chunk detaches
3. The chunk falls as a solid irregular shape
4. After 0.7-1.2s it shatters into 3-5 small fragments
5. Fragments continue falling to the bottom of the screen
6. The snow cap at the detachment point is visibly reduced but not zero
7. Same obstacle doesn't drop another chunk for ~2 seconds

- [ ] **Step 3: Final commit if any tweaks were needed**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "fix(weather): tune snow avalanche visual parameters"
```
