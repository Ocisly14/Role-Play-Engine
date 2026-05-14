# Weather Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen weather animation overlay to the simulation page with concrete weather objects (sun, clouds) and particle/atmosphere effects (rain, snow, fog, heat distortion, frost) that respond to the in-game weather state.

**Architecture:** Single React component `WeatherOverlay.tsx` with dual-layer cross-fade system. Canvas 2D for particle effects (rain, snow, storm), CSS for atmosphere (fog, frost, color tints) and concrete objects (sun, clouds), SVG `feTurbulence` filter for heat distortion. Sits at `z-index: 50` above all UI with `pointer-events: none`.

**Tech Stack:** React, TypeScript, Canvas 2D API, CSS animations/keyframes, SVG filters

**Spec:** `docs/superpowers/specs/2026-03-21-weather-overlay-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `client/src/components/simulation/WeatherOverlay.tsx` | All weather effects, particles, transitions, concrete elements |
| Modify | `client/src/views/SimulationPage.tsx` | Add `<WeatherOverlay>` to JSX |

---

### Task 1: Scaffold WeatherOverlay — Container + Transition System

**Files:**
- Create: `client/src/components/simulation/WeatherOverlay.tsx`

Build the outer shell: fixed full-screen container, dual-layer A/B cross-fade, DPR-aware canvas setup, resize handling, and `prefers-reduced-motion` detection. No weather effects yet — just the infrastructure.

- [ ] **Step 1: Create WeatherOverlay.tsx with types and container**

```tsx
// client/src/components/simulation/WeatherOverlay.tsx

import { useCallback, useEffect, useRef, useState } from "react";

export type WeatherType =
  | "clear"
  | "rain"
  | "fog"
  | "storm"
  | "snow"
  | "extreme_heat"
  | "extreme_cold";

const VALID_WEATHERS = new Set<WeatherType>([
  "clear", "rain", "fog", "storm", "snow", "extreme_heat", "extreme_cold",
]);

function normalizeWeather(w: string): WeatherType {
  return VALID_WEATHERS.has(w as WeatherType) ? (w as WeatherType) : "clear";
}

/** Weather types that use Canvas particles */
const PARTICLE_WEATHERS = new Set<WeatherType>(["rain", "snow", "storm", "extreme_cold"]);

interface WeatherOverlayProps {
  weather: string;
}

interface LayerState {
  weather: WeatherType;
  opacity: number;
}

export function WeatherOverlay({ weather: rawWeather }: WeatherOverlayProps) {
  const weather = normalizeWeather(rawWeather);
  const [layers, setLayers] = useState<{ current: LayerState; prev: LayerState | null }>({
    current: { weather, opacity: 1 },
    prev: null,
  });
  const prefersReducedMotion = useRef(false);

  // Detect reduced motion preference
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    prefersReducedMotion.current = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      prefersReducedMotion.current = e.matches;
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Handle weather transitions
  useEffect(() => {
    setLayers((prev) => {
      const newWeather = weather;
      if (prev.current.weather === newWeather) return prev;
      return {
        current: { weather: newWeather, opacity: 1 },
        prev: { weather: prev.current.weather, opacity: 0 },
      };
    });
  }, [weather]);

  const handleTransitionEnd = useCallback(() => {
    setLayers((prev) => (prev.prev ? { current: prev.current, prev: null } : prev));
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {/* Outgoing layer (fading out) */}
      {layers.prev && (
        <WeatherLayer
          weather={layers.prev.weather}
          opacity={layers.prev.opacity}
          onTransitionEnd={handleTransitionEnd}
          reducedMotion={prefersReducedMotion.current}
        />
      )}
      {/* Current layer */}
      {layers.current.weather !== "clear" && (
        <WeatherLayer
          weather={layers.current.weather}
          opacity={layers.current.opacity}
          reducedMotion={prefersReducedMotion.current}
        />
      )}
      {/* Clear: show sun layer separately (always visible when clear) */}
      {layers.current.weather === "clear" && (
        <WeatherLayer
          weather="clear"
          opacity={layers.current.opacity}
          reducedMotion={prefersReducedMotion.current}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add WeatherLayer sub-component with canvas infrastructure**

Add below the `WeatherOverlay` component in the same file:

```tsx
interface WeatherLayerProps {
  weather: WeatherType;
  opacity: number;
  onTransitionEnd?: () => void;
  reducedMotion: boolean;
}

function WeatherLayer({ weather, opacity, onTransitionEnd, reducedMotion }: WeatherLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const lightningTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const needsCanvas = PARTICLE_WEATHERS.has(weather);

  // Canvas setup + resize
  useEffect(() => {
    if (!needsCanvas) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
      }
    };
    resize();

    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
    };
  }, [needsCanvas]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      clearTimeout(lightningTimerRef.current);
    };
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        transition: "opacity 1.5s ease",
        willChange: "opacity",
      }}
      onTransitionEnd={onTransitionEnd}
    >
      {needsCanvas && (
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      )}
      {/* Weather-specific CSS layers will be added in subsequent tasks */}
    </div>
  );
}
```

- [ ] **Step 3: Add Particle type**

Add at the top of the file, below the type definitions:

```tsx
interface Particle {
  x: number;
  y: number;
  speed: number;
  length: number;  // rain line length or snow radius
  opacity: number;
  sway: number;    // horizontal drift offset (snow)
  width: number;   // rain line width
}
```

- [ ] **Step 4: Verify file compiles**

Run: `cd client && npx tsc --noEmit 2>&1 | grep WeatherOverlay`
Expected: No errors related to WeatherOverlay

- [ ] **Step 5: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: scaffold WeatherOverlay with transition system and canvas infrastructure"
```

---

### Task 2: Clear Weather — Sun + Tyndall Light Rays

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Add the clear-weather sun element and Tyndall light beams as CSS-only effects inside `WeatherLayer`.

- [ ] **Step 1: Add Sun component**

Add inside `WeatherLayer`, rendered when `weather === "clear" || weather === "extreme_heat"`:

```tsx
function Sun({ intense }: { intense?: boolean }) {
  const size = intense ? 160 : 120;
  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        left: 30,
        width: size,
        height: size,
        borderRadius: "50%",
        background: intense
          ? "radial-gradient(circle, rgba(255,255,255,1) 0%, rgba(255,200,50,0.8) 30%, rgba(255,160,0,0.3) 60%, transparent 75%)"
          : "radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,230,120,0.6) 35%, rgba(255,200,80,0.2) 60%, transparent 75%)",
        animation: intense ? "sunPulse 2s ease-in-out infinite" : "sunPulse 3s ease-in-out infinite",
        filter: intense ? "blur(2px)" : "blur(1px)",
      }}
    />
  );
}
```

- [ ] **Step 2: Add Tyndall light rays**

```tsx
const TYNDALL_RAYS = [
  { rotate: 25, width: 60, height: "70vh", opacity: 0.07, delay: "0s", duration: "8s" },
  { rotate: 35, width: 40, height: "80vh", opacity: 0.05, delay: "1s", duration: "10s" },
  { rotate: 15, width: 80, height: "60vh", opacity: 0.09, delay: "2s", duration: "12s" },
  { rotate: 45, width: 30, height: "75vh", opacity: 0.06, delay: "0.5s", duration: "9s" },
];

function TyndallRays() {
  return (
    <>
      {TYNDALL_RAYS.map((ray, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: 60,
            left: 70,
            width: ray.width,
            height: ray.height,
            background: `linear-gradient(180deg, rgba(255,240,200,${ray.opacity}) 0%, transparent 100%)`,
            transformOrigin: "top left",
            transform: `rotate(${ray.rotate}deg)`,
            animation: `tyndallSway ${ray.duration} ease-in-out infinite`,
            animationDelay: ray.delay,
            filter: "blur(8px)",
          }}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Add CSS keyframes via style tag**

Add a `<style>` block inside the `WeatherOverlay` container div (rendered once):

```tsx
<style>{`
  @keyframes sunPulse {
    0%, 100% { transform: scale(1); opacity: 0.9; }
    50% { transform: scale(1.06); opacity: 1; }
  }
  @keyframes tyndallSway {
    0%, 100% { transform: rotate(var(--ray-rotate)) translateX(0); }
    50% { transform: rotate(var(--ray-rotate)) translateX(8px); }
  }
  @keyframes cloudDrift {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(15px); }
  }
  @keyframes fogDrift1 {
    0% { transform: translateX(-10%); }
    100% { transform: translateX(10%); }
  }
  @keyframes fogDrift2 {
    0% { transform: translateX(10%); }
    100% { transform: translateX(-10%); }
  }
  @keyframes fogDrift3 {
    0% { transform: translateX(-5%); }
    100% { transform: translateX(5%); }
  }
  @keyframes heatRise {
    0% { transform: translateY(0); opacity: 0.06; }
    100% { transform: translateY(-100vh); opacity: 0; }
  }
  @keyframes heatShimmer {
    0% { transform: translateY(0); }
    100% { transform: translateY(-20px); }
  }
`}</style>
```

Note: Use inline `style` on the Tyndall rays with the actual rotate value rather than CSS custom properties for simplicity. The `tyndallSway` keyframe can just use a simple translateX sway since rotate is set inline.

- [ ] **Step 4: Wire Sun + Tyndall into WeatherLayer**

Inside `WeatherLayer`, after the canvas, add:

```tsx
{(weather === "clear" || weather === "extreme_heat") && (
  <>
    <Sun intense={weather === "extreme_heat"} />
    <TyndallRays />
    <div style={{
      position: "absolute", inset: 0,
      background: weather === "extreme_heat"
        ? "rgba(255,140,0,0.08)"
        : "rgba(255,245,220,0.03)",
    }} />
  </>
)}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add clear weather sun and Tyndall light rays"
```

---

### Task 3: Rain + Snow Particle Systems

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Implement Canvas particle systems for rain and snow effects.

- [ ] **Step 1: Add particle initialization helpers**

```tsx
function createRainParticles(count: number, w: number, h: number): Particle[] {
  return Array.from({ length: count }, () => ({
    x: Math.random() * w * 1.2,
    y: Math.random() * h,
    speed: 8 + Math.random() * 6,
    length: 15 + Math.random() * 15,
    opacity: 0.3 + Math.random() * 0.3,
    sway: 0,
    width: 1 + Math.random(),
  }));
}

function createSnowParticles(count: number, w: number, h: number): Particle[] {
  return Array.from({ length: count }, () => {
    const radius = 1 + Math.random() * 3;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      speed: 0.5 + radius * 0.6,
      length: radius,
      opacity: 0.4 + (radius / 4) * 0.6,
      sway: Math.random() * Math.PI * 2,
      width: 0,
    };
  });
}
```

- [ ] **Step 2: Add rain draw/update function**

```tsx
function drawRain(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  for (const p of particles) {
    ctx.strokeStyle = `rgba(174,194,224,${p.opacity})`;
    ctx.lineWidth = p.width;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.length * 0.3, p.y + p.length);
    ctx.stroke();

    p.x -= p.speed * 0.3;
    p.y += p.speed;

    if (p.y > h || p.x < -20) {
      p.x = Math.random() * w * 1.2;
      p.y = -p.length;
      p.speed = 8 + Math.random() * 6;
    }
  }
}
```

- [ ] **Step 3: Add snow draw/update function**

```tsx
let snowTime = 0;

function drawSnow(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  snowTime += 0.01;
  for (const p of particles) {
    ctx.fillStyle = `rgba(255,255,255,${p.opacity})`;
    ctx.beginPath();
    ctx.arc(p.x + Math.sin(snowTime + p.sway) * 1.2, p.y, p.length, 0, Math.PI * 2);
    ctx.fill();

    p.y += p.speed;
    p.x += Math.sin(snowTime * 0.5 + p.sway) * 0.3;

    if (p.y > h + 5) {
      p.y = -p.length;
      p.x = Math.random() * w;
    }
  }
}
```

- [ ] **Step 4: Wire particle animation loop into WeatherLayer**

Add a `useEffect` in `WeatherLayer` that starts the animation loop:

```tsx
useEffect(() => {
  if (!needsCanvas || reducedMotion) return;
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = window.innerWidth;
  const h = window.innerHeight;

  if (weather === "rain") {
    particlesRef.current = createRainParticles(200, w, h);
  } else if (weather === "snow") {
    particlesRef.current = createSnowParticles(150, w, h);
  } else if (weather === "storm") {
    particlesRef.current = createRainParticles(400, w, h);
    // Increase speed for storm
    for (const p of particlesRef.current) {
      p.speed = 12 + Math.random() * 8;
      p.length = 20 + Math.random() * 15;
    }
  } else if (weather === "extreme_cold") {
    particlesRef.current = createSnowParticles(50, w, h);
  }

  const animate = () => {
    if (weather === "rain" || weather === "storm") {
      drawRain(ctx, particlesRef.current, w, h);
    } else if (weather === "snow" || weather === "extreme_cold") {
      drawSnow(ctx, particlesRef.current, w, h);
    }
    animFrameRef.current = requestAnimationFrame(animate);
  };
  animFrameRef.current = requestAnimationFrame(animate);

  return () => cancelAnimationFrame(animFrameRef.current);
}, [weather, needsCanvas, reducedMotion]);
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add rain and snow Canvas particle systems"
```

---

### Task 4: Cloud Elements (Rain, Snow, Storm)

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Add the concrete cloud CSS elements for rain, snow, and storm weather.

- [ ] **Step 1: Add Cloud component**

```tsx
type CloudVariant = "rain" | "snow" | "storm";

const CLOUD_CONFIGS: Record<CloudVariant, {
  color1: string; color2: string; count: number; topOffset: number; opacity: number; height: number;
}> = {
  rain: {
    color1: "rgba(60,65,75,0.7)", color2: "rgba(40,45,55,0.5)",
    count: 5, topOffset: -30, opacity: 0.8, height: 80,
  },
  snow: {
    color1: "rgba(180,185,195,0.6)", color2: "rgba(200,205,215,0.4)",
    count: 5, topOffset: -25, opacity: 0.7, height: 70,
  },
  storm: {
    color1: "rgba(30,35,45,0.85)", color2: "rgba(20,25,35,0.65)",
    count: 7, topOffset: -20, opacity: 0.9, height: 120,
  },
};

function Clouds({ variant }: { variant: CloudVariant }) {
  const cfg = CLOUD_CONFIGS[variant];
  const blobs = Array.from({ length: cfg.count }, (_, i) => {
    const w = 180 + Math.sin(i * 2.1) * 80;
    const left = (i / cfg.count) * 100 - 10 + Math.sin(i * 1.3) * 8;
    const top = cfg.topOffset + Math.sin(i * 1.7) * 15;
    return { w, left, top, key: i };
  });

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0,
      height: cfg.height + 60,
      animation: "cloudDrift 18s ease-in-out infinite",
    }}>
      {blobs.map((b) => (
        <div
          key={b.key}
          style={{
            position: "absolute",
            left: `${b.left}%`,
            top: b.top,
            width: b.w,
            height: cfg.height,
            borderRadius: "50%",
            background: `radial-gradient(ellipse, ${cfg.color1} 0%, ${cfg.color2} 70%, transparent 100%)`,
            opacity: cfg.opacity,
            filter: "blur(6px)",
          }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire clouds into WeatherLayer**

Inside `WeatherLayer`, after the canvas element:

```tsx
{(weather === "rain" || weather === "snow" || weather === "storm") && (
  <Clouds variant={weather === "snow" ? "snow" : weather === "storm" ? "storm" : "rain"} />
)}
```

- [ ] **Step 3: Add darkening overlay for rain and storm**

```tsx
{(weather === "rain" || weather === "storm") && (
  <div style={{
    position: "absolute", inset: 0,
    background: weather === "storm" ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.08)",
  }} />
)}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add cloud elements for rain, snow, and storm weather"
```

---

### Task 5: Storm Lightning

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Add lightning flash effect for storm weather.

- [ ] **Step 1: Add lightning state and effect**

Inside `WeatherLayer`, add state and timer logic:

```tsx
const [lightningOpacity, setLightningOpacity] = useState(0);

useEffect(() => {
  if (weather !== "storm" || reducedMotion) return;

  const flash = () => {
    setLightningOpacity(0.7);
    setTimeout(() => setLightningOpacity(0), 80);

    // Optional double flash
    if (Math.random() > 0.5) {
      setTimeout(() => {
        setLightningOpacity(0.4);
        setTimeout(() => setLightningOpacity(0), 80);
      }, 230);
    }
  };

  const scheduleFlash = () => {
    const delay = 3000 + Math.random() * 5000;
    lightningTimerRef.current = setTimeout(() => {
      flash();
      scheduleFlash();
    }, delay);
  };
  scheduleFlash();

  return () => {
    clearTimeout(lightningTimerRef.current);
    setLightningOpacity(0);
  };
}, [weather, reducedMotion]);
```

- [ ] **Step 2: Add lightning overlay div**

```tsx
{weather === "storm" && lightningOpacity > 0 && (
  <div style={{
    position: "absolute", inset: 0,
    background: `rgba(255,255,255,${lightningOpacity})`,
    transition: "background 0.2s ease-out",
  }} />
)}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add storm lightning flash effect"
```

---

### Task 6: Fog Effect

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Add the 3-layer drifting fog CSS effect.

- [ ] **Step 1: Add Fog component**

```tsx
function Fog() {
  const fogLayers = [
    { animation: "fogDrift1 20s ease-in-out infinite alternate", opacity: 0.4,
      background: "radial-gradient(ellipse at 30% 50%, rgba(255,255,255,0.5) 0%, transparent 70%)" },
    { animation: "fogDrift2 30s ease-in-out infinite alternate", opacity: 0.35,
      background: "radial-gradient(ellipse at 70% 40%, rgba(240,240,245,0.45) 0%, transparent 65%)" },
    { animation: "fogDrift3 25s ease-in-out infinite alternate", opacity: 0.3,
      background: "radial-gradient(ellipse at 50% 60%, rgba(245,245,250,0.4) 0%, transparent 60%)" },
  ];

  return (
    <>
      {fogLayers.map((layer, i) => (
        <div
          key={i}
          style={{
            position: "absolute", inset: 0,
            background: layer.background,
            opacity: layer.opacity,
            animation: layer.animation,
          }}
        />
      ))}
      <div style={{
        position: "absolute", inset: 0,
        backdropFilter: "blur(1px)",
        WebkitBackdropFilter: "blur(1px)",
      }} />
    </>
  );
}
```

- [ ] **Step 2: Wire into WeatherLayer**

```tsx
{weather === "fog" && <Fog />}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add fog drifting layers effect"
```

---

### Task 7: Extreme Heat — SVG Distortion + Rising Heat

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Add heat distortion using SVG `feTurbulence` filter and rising heat streak animations.

- [ ] **Step 1: Add HeatDistortion component**

```tsx
function HeatDistortion() {
  return (
    <>
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="weather-heat-distortion" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="turbulence" baseFrequency="0.01 0.03" numOctaves={3} />
            <feDisplacementMap in="SourceGraphic" scale={12} />
          </filter>
        </defs>
      </svg>
      <div style={{
        position: "absolute", inset: 0,
        filter: "url(#weather-heat-distortion)",
        animation: "heatShimmer 4s ease-in-out infinite alternate",
      }}>
        {/* Rising heat streaks */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              bottom: 0,
              left: `${20 + i * 30}%`,
              width: 80 + i * 20,
              height: "100vh",
              background: "linear-gradient(0deg, rgba(255,200,100,0.06) 0%, transparent 40%)",
              animation: `heatRise ${8 + i * 2}s linear infinite`,
              animationDelay: `${i * 2}s`,
              filter: "blur(20px)",
            }}
          />
        ))}
      </div>
      <div style={{
        position: "absolute", inset: 0,
        background: "rgba(255,140,0,0.08)",
      }} />
    </>
  );
}
```

- [ ] **Step 2: Wire into WeatherLayer**

The Sun is already rendered for `extreme_heat` from Task 2. Add:

```tsx
{weather === "extreme_heat" && <HeatDistortion />}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add extreme heat SVG distortion and rising heat streaks"
```

---

### Task 8: Extreme Cold — Frost + Vignette

**Files:**
- Modify: `client/src/components/simulation/WeatherOverlay.tsx`

Add frost border, blue tint, and vignette. Canvas snow particles (50) are already handled by Task 3 for `extreme_cold`.

- [ ] **Step 1: Add Frost component**

```tsx
function Frost() {
  return (
    <>
      {/* Blue tint */}
      <div style={{ position: "absolute", inset: 0, background: "rgba(100,150,220,0.12)" }} />
      {/* Frost border + vignette */}
      <div style={{
        position: "absolute", inset: 0,
        boxShadow: "inset 0 0 80px 40px rgba(200,220,255,0.3), inset 0 0 200px 80px rgba(180,200,240,0.1)",
      }} />
    </>
  );
}
```

- [ ] **Step 2: Wire into WeatherLayer**

```tsx
{weather === "extreme_cold" && <Frost />}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx
git commit -m "feat: add extreme cold frost and vignette effect"
```

---

### Task 9: Integrate into SimulationPage

**Files:**
- Modify: `client/src/views/SimulationPage.tsx`

Add the `<WeatherOverlay>` component to the simulation page.

- [ ] **Step 1: Import and add WeatherOverlay**

At top of `SimulationPage.tsx`, add import:

```tsx
import { WeatherOverlay } from "../components/simulation/WeatherOverlay";
```

In the JSX, immediately after the `.sim-canvas-layer` closing `</div>` (line 426) and before the loading overlay:

```tsx
      </div>

      {/* Weather animation overlay */}
      <WeatherOverlay weather={state.weather} />

      {/* Loading / Error overlays */}
```

- [ ] **Step 2: Verify build compiles**

Run: `cd client && npx tsc --noEmit 2>&1 | grep -E "WeatherOverlay|SimulationPage"`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/WeatherOverlay.tsx client/src/views/SimulationPage.tsx
git commit -m "feat: integrate WeatherOverlay into SimulationPage"
```

---

### Task 10: Manual Visual Test

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

Run: `cd client && pnpm dev`

- [ ] **Step 2: Test each weather type**

Open the simulation page. If weather is clear, verify the sun and Tyndall rays are visible in the top-left. To test other weathers, either:
- Wait for the simulation to naturally change weather, or
- Temporarily hardcode the weather prop in SimulationPage: `<WeatherOverlay weather="rain" />`

Verify each weather type visually:
- `clear` — Sun + light rays in top-left, faint warm tint
- `rain` — Dark clouds at top + raindrops falling diagonally + slight darkening
- `snow` — Gray clouds at top + snowflakes drifting down with sway
- `storm` — Heavy dark clouds + dense rain + darkening + periodic lightning flashes
- `fog` — 3 drifting fog layers + slight blur
- `extreme_heat` — Intense sun + heat shimmer distortion + warm tint + rising streaks
- `extreme_cold` — Blue tint + frost/ice border + sparse snowfall

- [ ] **Step 3: Test weather transition**

Change the hardcoded weather prop to verify the 1.5s cross-fade works smoothly between different types.

- [ ] **Step 4: Remove any test hardcoding and commit**

Restore `<WeatherOverlay weather={state.weather} />` if changed.

```bash
git add -A
git commit -m "feat: weather overlay visual testing complete"
```
