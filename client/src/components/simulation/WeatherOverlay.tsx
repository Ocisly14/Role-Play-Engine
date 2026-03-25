import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ───────────────────────── types ───────────────────────── */

type WeatherType =
  | "clear"
  | "rain"
  | "fog"
  | "storm"
  | "snow"
  | "extreme_heat"
  | "extreme_cold";

interface WeatherOverlayProps {
  weather: string;
}

/* ────────────────── reduced-motion hook ────────────────── */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/* ─────────────── particle canvas (rain / snow) ─────────── */

interface Particle {
  x: number;
  y: number;
  speed: number;
  length: number;
  radius: number;
  opacity: number;
  sway: number;
  swaySpeed: number;
}

interface WeatherObstacle {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface RainSplashParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  opacity: number;
}

interface SnowCap {
  heights: number[];
  segmentWidth: number;
  maxDepth: number;
}

interface SurfaceImpact {
  obstacle: WeatherObstacle;
  x: number;
  y: number;
  progress: number;
}

const WEATHER_OBSTACLE_SELECTOR = "[data-weather-obstacle]";
const OBSTACLE_HORIZONTAL_PADDING = 6;
const SNOW_CAP_INSET = 4;
const MAX_SPLASH_PARTICLES = 220;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isVisibleWeatherObstacle(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  return Number.parseFloat(style.opacity || "1") > 0.02;
}

function collectWeatherObstacles(): WeatherObstacle[] {
  if (typeof document === "undefined") return [];

  return Array.from(
    document.querySelectorAll<HTMLElement>(WEATHER_OBSTACLE_SELECTOR)
  )
    .filter(isVisibleWeatherObstacle)
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.dataset.weatherObstacle ?? `obstacle-${index}`,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    })
    .filter(
      (obstacle) =>
        obstacle.width > 24 &&
        obstacle.height > 12 &&
        obstacle.bottom > 0 &&
        obstacle.top < window.innerHeight &&
        obstacle.right > 0 &&
        obstacle.left < window.innerWidth
    )
    .sort((a, b) => a.top - b.top);
}

function respawnRainParticle(particle: Particle, width: number): void {
  particle.y = -particle.length - Math.random() * 40;
  particle.x = Math.random() * width * 1.3 - width * 0.15;
}

function respawnSnowParticle(particle: Particle, width: number): void {
  particle.y = -particle.radius * 3 - Math.random() * 60;
  particle.x = Math.random() * width;
}

function initRainParticles(w: number, h: number, count: number): Particle[] {
  return Array.from({ length: count }, () => ({
    x: Math.random() * w * 1.3,
    y: Math.random() * h,
    speed: 8 + Math.random() * 6,
    length: 15 + Math.random() * 15,
    radius: 0,
    opacity: 0.2 + Math.random() * 0.4,
    sway: 0,
    swaySpeed: 0,
  }));
}

function initSnowParticles(w: number, h: number, count: number): Particle[] {
  return Array.from({ length: count }, () => {
    const depth = Math.random();
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      speed: 0.3 + depth * 1.8,
      length: 0,
      radius: 1 + depth * 3.5,
      opacity: 0.25 + depth * 0.55,
      sway: 15 + Math.random() * 35,
      swaySpeed: 0.3 + Math.random() * 1.2,
    };
  });
}

function findContainingObstacle(
  obstacles: WeatherObstacle[],
  x: number,
  y: number
): WeatherObstacle | null {
  for (const obstacle of obstacles) {
    if (
      x >= obstacle.left &&
      x <= obstacle.right &&
      y >= obstacle.top &&
      y <= obstacle.bottom
    ) {
      return obstacle;
    }
  }
  return null;
}

function findRainImpact(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  obstacles: WeatherObstacle[]
): SurfaceImpact | null {
  const deltaY = endY - startY;
  if (deltaY <= 0) return null;

  let hit: SurfaceImpact | null = null;

  for (const obstacle of obstacles) {
    if (startY >= obstacle.bottom || endY < obstacle.top) continue;

    const progress = (obstacle.top - startY) / deltaY;
    if (progress < 0 || progress > 1) continue;

    const impactX = startX + (endX - startX) * progress;
    if (
      impactX < obstacle.left - OBSTACLE_HORIZONTAL_PADDING ||
      impactX > obstacle.right + OBSTACLE_HORIZONTAL_PADDING
    ) {
      continue;
    }

    if (!hit || progress < hit.progress) {
      hit = {
        obstacle,
        x: impactX,
        y: obstacle.top,
        progress,
      };
    }
  }

  return hit;
}

function ensureSnowCaps(
  obstacles: WeatherObstacle[],
  previousCaps: Record<string, SnowCap>
): Record<string, SnowCap> {
  const nextCaps: Record<string, SnowCap> = {};

  for (const obstacle of obstacles) {
    // Use a denser sampling grid so snow height follows local landing density
    // instead of feeling like one shared strip across the whole obstacle.
    const segmentCount = Math.max(24, Math.ceil(obstacle.width / 8));
    const previous = previousCaps[obstacle.id];
    const heights = Array.from({ length: segmentCount }, (_, index) => {
      if (!previous || previous.heights.length === 0) return 0;
      const sourceIndex = Math.round(
        (index / Math.max(segmentCount - 1, 1)) *
          Math.max(previous.heights.length - 1, 0)
      );
      return previous.heights[sourceIndex] ?? 0;
    });

    nextCaps[obstacle.id] = {
      heights,
      segmentWidth: obstacle.width / segmentCount,
      maxDepth: clamp(obstacle.height * 0.24, 10, 28),
    };
  }

  return nextCaps;
}

function getSnowDepthAt(
  obstacle: WeatherObstacle,
  x: number,
  snowCaps: Record<string, SnowCap>
): number {
  const snowCap = snowCaps[obstacle.id];
  if (!snowCap || snowCap.heights.length === 0) return 0;

  const normalizedX = clamp(
    (x - obstacle.left) / Math.max(obstacle.width, 1),
    0,
    1
  );
  const scaledIndex = normalizedX * Math.max(snowCap.heights.length - 1, 0);
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(snowCap.heights.length - 1, lowerIndex + 1);
  const blend = scaledIndex - lowerIndex;
  const lower = snowCap.heights[lowerIndex] ?? 0;
  const upper = snowCap.heights[upperIndex] ?? lower;

  return lower + (upper - lower) * blend;
}

function findSnowImpact(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  obstacles: WeatherObstacle[],
  snowCaps: Record<string, SnowCap>
): SurfaceImpact | null {
  const deltaY = endY - startY;
  if (deltaY <= 0) return null;

  let hit: SurfaceImpact | null = null;

  for (const obstacle of obstacles) {
    if (startY >= obstacle.bottom + 4 || endY < obstacle.top - 24) continue;

    let progress = clamp((obstacle.top - startY) / deltaY, 0, 1);
    let impactX = startX + (endX - startX) * progress;
    let surfaceY = obstacle.top - getSnowDepthAt(obstacle, impactX, snowCaps);

    progress = (surfaceY - startY) / deltaY;
    if (progress < 0 || progress > 1) continue;

    impactX = startX + (endX - startX) * progress;
    surfaceY = obstacle.top - getSnowDepthAt(obstacle, impactX, snowCaps);

    if (
      impactX < obstacle.left + SNOW_CAP_INSET ||
      impactX > obstacle.right - SNOW_CAP_INSET
    ) {
      continue;
    }

    if (startY > surfaceY || endY < surfaceY) continue;

    if (!hit || progress < hit.progress) {
      hit = {
        obstacle,
        x: impactX,
        y: surfaceY,
        progress,
      };
    }
  }

  return hit;
}

function addRainSplash(
  splashes: RainSplashParticle[],
  x: number,
  y: number,
  storm: boolean
): void {
  const splashCount = storm ? 6 : 4;

  for (let index = 0; index < splashCount; index += 1) {
    splashes.push({
      x,
      y: y - 1,
      vx: (Math.random() - 0.5) * (storm ? 2.2 : 1.5),
      vy: -0.9 - Math.random() * (storm ? 2.6 : 1.8),
      size: 1 + Math.random() * (storm ? 1.6 : 1.1),
      life: 8 + Math.random() * 8,
      maxLife: 16,
      opacity: 0.35 + Math.random() * 0.25,
    });
  }

  if (splashes.length > MAX_SPLASH_PARTICLES) {
    splashes.splice(0, splashes.length - MAX_SPLASH_PARTICLES);
  }
}

function drawRainSplashes(
  ctx: CanvasRenderingContext2D,
  splashes: RainSplashParticle[]
): RainSplashParticle[] {
  const active: RainSplashParticle[] = [];

  for (const splash of splashes) {
    splash.x += splash.vx;
    splash.y += splash.vy;
    splash.vy += 0.14;
    splash.life -= 1;

    if (splash.life <= 0) continue;

    active.push(splash);
    const alpha = (splash.life / splash.maxLife) * splash.opacity;
    ctx.fillStyle = `rgba(210,230,255,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(
      splash.x,
      splash.y,
      splash.size,
      splash.size * 0.65,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  return active;
}

function depositSnow(
  obstacle: WeatherObstacle,
  x: number,
  amount: number,
  snowCaps: Record<string, SnowCap>
): void {
  const snowCap = snowCaps[obstacle.id];
  if (!snowCap) return;

  const normalizedX = clamp(
    (x - obstacle.left) / Math.max(obstacle.width, 1),
    0,
    1
  );
  const centerIndex = normalizedX * Math.max(snowCap.heights.length - 1, 0);
  const minIndex = Math.max(0, Math.floor(centerIndex) - 1);
  const maxIndex = Math.min(
    snowCap.heights.length - 1,
    Math.ceil(centerIndex) + 1
  );

  for (let index = minIndex; index <= maxIndex; index += 1) {
    const distance = Math.abs(index - centerIndex);
    const falloff = Math.exp(-(distance * distance) / 0.42);
    if (falloff < 0.06) continue;

    snowCap.heights[index] = Math.min(
      snowCap.maxDepth,
      snowCap.heights[index] + amount * falloff
    );
  }
}

function settleSnowCap(snowCap: SnowCap): void {
  const heights = snowCap.heights;
  if (heights.length < 2) return;

  const maxSlopeDelta = clamp(snowCap.segmentWidth * 0.22, 0.8, 1.5);

  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < heights.length - 1; index += 1) {
      const left = heights[index];
      const right = heights[index + 1];
      const delta = left - right;

      if (Math.abs(delta) <= maxSlopeDelta) continue;

      const transfer = (Math.abs(delta) - maxSlopeDelta) * 0.28;
      if (delta > 0) {
        heights[index] = Math.max(0, left - transfer);
        heights[index + 1] = Math.min(snowCap.maxDepth, right + transfer);
      } else {
        heights[index] = Math.min(snowCap.maxDepth, left + transfer);
        heights[index + 1] = Math.max(0, right - transfer);
      }
    }
  }
}

function drawSnowCaps(
  ctx: CanvasRenderingContext2D,
  obstacles: WeatherObstacle[],
  snowCaps: Record<string, SnowCap>
): void {
  for (const obstacle of obstacles) {
    const snowCap = snowCaps[obstacle.id];
    if (!snowCap || snowCap.heights.every((height) => height < 0.2)) continue;

    const innerLeft = obstacle.left + SNOW_CAP_INSET;
    const innerRight = obstacle.right - SNOW_CAP_INSET;
    // Taper zone beyond the inset boundary (smooth ramp over this distance)
    const taperWidth = SNOW_CAP_INSET * 2;

    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,0.16)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(245,250,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(innerLeft, obstacle.top + 1);

    for (let index = 0; index < snowCap.heights.length; index += 1) {
      const x = obstacle.left + index * snowCap.segmentWidth;
      if (x < innerLeft || x > innerRight) continue;
      // Taper from 0→1 over taperWidth inside the inset boundary
      const dL = x - innerLeft;
      const dR = innerRight - x;
      const t = clamp(Math.min(dL, dR) / taperWidth, 0, 1);
      const taper = t * t * (3 - 2 * t);
      const y = obstacle.top - snowCap.heights[index] * taper;
      ctx.lineTo(x, y);
    }

    ctx.lineTo(innerRight, obstacle.top + 1);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let penDown = false;
    for (let index = 0; index < snowCap.heights.length; index += 1) {
      const x = obstacle.left + index * snowCap.segmentWidth;
      if (x < innerLeft || x > innerRight) continue;
      const dL = x - innerLeft;
      const dR = innerRight - x;
      const t = clamp(Math.min(dL, dR) / taperWidth, 0, 1);
      const taper = t * t * (3 - 2 * t);
      const h = snowCap.heights[index] * taper;
      if (h < 0.2) {
        penDown = false;
        continue;
      }
      const y = obstacle.top - h;
      if (!penDown) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}

interface CanvasLayerProps {
  type: "rain" | "snow" | "storm" | "extreme_cold_snow";
  reducedMotion: boolean;
}

const CanvasLayer: React.FC<CanvasLayerProps> = ({ type, reducedMotion }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const obstaclesRef = useRef<WeatherObstacle[]>([]);
  const rainSplashesRef = useRef<RainSplashParticle[]>([]);
  const snowCapsRef = useRef<Record<string, SnowCap>>({});
  const rafRef = useRef(0);
  const snowTimeRef = useRef(0);

  const updateObstacles = useCallback(() => {
    const obstacles = collectWeatherObstacles();
    obstaclesRef.current = obstacles;
    if (type === "snow" || type === "extreme_cold_snow") {
      snowCapsRef.current = ensureSnowCaps(obstacles, snowCapsRef.current);
    } else {
      snowCapsRef.current = {};
    }
  }, [type]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const particles = particlesRef.current;
    const obstacles = obstaclesRef.current;

    if (type === "rain" || type === "storm") {
      const isStorm = type === "storm";
      for (const p of particles) {
        const lineW = isStorm ? 1.5 : 1 + p.opacity * 0.5;
        const angle = isStorm ? 0.4 : 0.25;
        const nextX = p.x + p.speed * angle;
        const nextY = p.y + p.speed;

        if (findContainingObstacle(obstacles, p.x, p.y)) {
          respawnRainParticle(p, w);
          continue;
        }

        const impact = findRainImpact(p.x, p.y, nextX, nextY, obstacles);

        ctx.strokeStyle = `rgba(180,210,255,${p.opacity})`;
        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        if (impact) {
          ctx.lineTo(impact.x, impact.y);
        } else {
          ctx.lineTo(p.x + p.length * angle, p.y + p.length);
        }
        ctx.stroke();

        if (impact) {
          addRainSplash(rainSplashesRef.current, impact.x, impact.y, isStorm);
          respawnRainParticle(p, w);
          continue;
        }

        p.y = nextY;
        p.x = nextX;

        if (p.y > h) {
          respawnRainParticle(p, w);
        }
        if (p.x > w + 20) {
          p.x = -20;
        }
      }

      // Splash effect at bottom for storm
      if (isStorm) {
        for (const p of particles) {
          if (p.y > h - 5 && p.y < h + 5) {
            ctx.fillStyle = `rgba(200,220,255,${p.opacity * 0.3})`;
            ctx.beginPath();
            ctx.ellipse(p.x, h - 2, 3, 1.5, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      rainSplashesRef.current = drawRainSplashes(ctx, rainSplashesRef.current);
    } else {
      snowTimeRef.current += 0.012;
      const t = snowTimeRef.current;
      for (const p of particles) {
        const currentX =
          p.x + Math.sin(t * p.swaySpeed + p.sway * 0.1) * p.sway;
        const nextBaseX = p.x + Math.sin(t * 0.3 + p.sway) * 0.15;
        const nextY = p.y + p.speed;
        const nextTime = t + 0.012;
        const nextX =
          nextBaseX + Math.sin(nextTime * p.swaySpeed + p.sway * 0.1) * p.sway;

        if (findContainingObstacle(obstacles, currentX, p.y)) {
          respawnSnowParticle(p, w);
          continue;
        }

        const impact = findSnowImpact(
          currentX,
          p.y,
          nextX,
          nextY,
          obstacles,
          snowCapsRef.current
        );

        if (impact) {
          const snowAmount = 0.08 + p.radius * 0.12 + p.opacity * 0.05;
          depositSnow(
            impact.obstacle,
            impact.x,
            snowAmount,
            snowCapsRef.current
          );
          const snowCap = snowCapsRef.current[impact.obstacle.id];
          if (snowCap) {
            settleSnowCap(snowCap);
          }
          respawnSnowParticle(p, w);
          continue;
        }

        const gradient = ctx.createRadialGradient(
          currentX,
          p.y,
          0,
          currentX,
          p.y,
          p.radius
        );
        gradient.addColorStop(0, `rgba(255,255,255,${p.opacity})`);
        gradient.addColorStop(0.6, `rgba(255,255,255,${p.opacity * 0.6})`);
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(currentX, p.y, p.radius * 1.5, 0, Math.PI * 2);
        ctx.fill();

        p.y = nextY;
        p.x = nextBaseX;

        if (p.y > h + p.radius * 2) {
          respawnSnowParticle(p, w);
        }
      }

      drawSnowCaps(ctx, obstacles, snowCapsRef.current);
    }

    ctx.restore();
    rafRef.current = requestAnimationFrame(draw);
  }, [type]);

  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let resizeTimer: ReturnType<typeof setTimeout>;
    rainSplashesRef.current = [];
    snowTimeRef.current = 0;
    updateObstacles();

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const count =
        type === "storm"
          ? 500
          : type === "rain"
            ? 250
            : type === "snow"
              ? 180
              : 60;
      if (type === "rain" || type === "storm") {
        particlesRef.current = initRainParticles(w, h, count);
      } else {
        particlesRef.current = initSnowParticles(w, h, count);
      }
      updateObstacles();
    };

    const debouncedResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };

    const obstacleSyncId = window.setInterval(updateObstacles, 160);

    resize();
    window.addEventListener("resize", debouncedResize);
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      window.clearInterval(obstacleSyncId);
      window.removeEventListener("resize", debouncedResize);
      clearTimeout(resizeTimer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [type, reducedMotion, draw, updateObstacles]);

  if (reducedMotion) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
};

/* ──────────────────────── Sun ──────────────────────── */

const Sun: React.FC<{ size?: number; intensity?: number }> = ({
  size = 200,
  intensity = 1,
}) => {
  const offset = size * -0.45;
  return (
    <div
      style={{
        position: "absolute",
        top: offset,
        left: offset,
        width: size,
        height: size,
      }}
    >
      {/* Outermost ambient glow — very large, very soft */}
      <div
        style={{
          position: "absolute",
          inset: -size * 1.0,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,230,130,${0.06 * intensity}) 0%, rgba(255,200,80,${0.03 * intensity}) 40%, transparent 65%)`,
        }}
      />
      {/* Outer corona */}
      <div
        style={{
          position: "absolute",
          inset: -size * 0.55,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,215,100,${0.15 * intensity}) 0%, rgba(255,180,60,${0.07 * intensity}) 45%, transparent 75%)`,
          animation: "sunPulse 5s ease-in-out infinite",
        }}
      />
      {/* Rotating lens flare halo ring */}
      <div
        style={{
          position: "absolute",
          inset: -size * 0.25,
          borderRadius: "50%",
          border: `2px solid rgba(255,220,120,${0.08 * intensity})`,
          boxShadow: `inset 0 0 ${size * 0.15}px rgba(255,210,100,${0.06 * intensity}), 0 0 ${size * 0.15}px rgba(255,210,100,${0.04 * intensity})`,
          animation: "haloRotate 30s linear infinite",
        }}
      />
      {/* Second halo ring — counter-rotate */}
      <div
        style={{
          position: "absolute",
          inset: -size * 0.35,
          borderRadius: "50%",
          border: `1px solid rgba(255,230,150,${0.05 * intensity})`,
          boxShadow: `0 0 ${size * 0.1}px rgba(255,220,120,${0.03 * intensity})`,
          animation: "haloRotateReverse 45s linear infinite",
        }}
      />
      {/* Middle warm glow */}
      <div
        style={{
          position: "absolute",
          inset: -size * 0.2,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,200,80,${0.3 * intensity}) 0%, rgba(255,170,40,${0.12 * intensity}) 50%, transparent 85%)`,
          filter: "blur(6px)",
          animation: "sunPulse 4s ease-in-out 0.8s infinite",
        }}
      />
      {/* Core — bright white-hot center */}
      <div
        style={{
          position: "absolute",
          inset: size * 0.12,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,255,245,${0.98 * intensity}) 0%, rgba(255,245,200,${0.85 * intensity}) 25%, rgba(255,220,120,${0.5 * intensity}) 55%, rgba(255,180,60,${0.15 * intensity}) 80%, transparent 100%)`,
          boxShadow: `0 0 ${size * 0.35}px ${size * 0.12}px rgba(255,220,100,${0.5 * intensity}), 0 0 ${size * 0.7}px ${size * 0.25}px rgba(255,180,60,${0.2 * intensity})`,
          animation: "sunPulse 3.5s ease-in-out infinite",
        }}
      />
      {/* Hot-spot flare */}
      <div
        style={{
          position: "absolute",
          top: size * 0.3,
          left: size * 0.3,
          width: size * 0.2,
          height: size * 0.2,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,255,255,${0.7 * intensity}) 0%, transparent 60%)`,
          filter: "blur(2px)",
          animation: "sunPulse 2.5s ease-in-out 1.2s infinite",
        }}
      />
    </div>
  );
};

/* ──────────────────── Tyndall Rays ──────────────────── */

const TyndallRays: React.FC<{ intense?: boolean }> = ({ intense }) => {
  // 10 rays, each 36° apart, forming a full 360° fan.
  // The whole group rotates continuously so rays sweep across the visible
  // quadrant (top-left → bottom-right) and disappear off-screen, then
  // new ones rotate in from the other side.
  const rays = useMemo(() => {
    const op = intense ? 0.8 : 0.75;
    return Array.from({ length: 10 }, (_, i) => ({
      angle: i * 36,
      thickness: 35 + (i % 3) * 10,
      length: 1300 + (i % 4) * 100,
      op: op - (i % 3) * 0.08,
      dur: 8 + (i % 4) * 1.5,
    }));
  }, [intense]);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Rotating container — full 360° loop, rays enter and leave view naturally */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          animation: "raysFullRotate 120s linear infinite",
        }}
      >
        {rays.map((r, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: r.length,
              height: r.thickness,
              transformOrigin: "0 50%",
              transform: `rotate(${r.angle}deg)`,
              background: `linear-gradient(90deg, rgba(255,245,180,${r.op}) 0%, rgba(255,230,140,${r.op * 0.5}) 25%, rgba(255,215,100,${r.op * 0.2}) 50%, transparent 85%)`,
              filter: "blur(10px)",
              animation: `rayPulse ${r.dur}s ease-in-out infinite alternate`,
            }}
          />
        ))}
      </div>
    </div>
  );
};

/* ──────────────────── Cloud Cluster ──────────────────── */

interface CloudProps {
  darkness?: number;
  coverageHeight?: number;
}

const Clouds: React.FC<CloudProps> = ({
  darkness = 0.5,
  coverageHeight = 140,
}) => {
  const d = Math.min(darkness, 1);
  // Cloud colors: lighter base so the shape is visible against any background
  const coreR = Math.round(70 + (1 - d) * 80); // 70 (dark/storm) – 150 (light/snow)
  const coreG = Math.round(75 + (1 - d) * 80);
  const coreB = Math.round(85 + (1 - d) * 70);

  return (
    <div
      style={{
        position: "absolute",
        top: -40,
        left: "10%",
        width: "80%",
        height: coverageHeight + 100,
      }}
    >
      {/* Main cloud bodies — large, visible, overlapping puffy shapes */}
      {[
        { w: "55%", h: 140, left: "5%", top: 0, blur: 8, dur: 20 },
        { w: "60%", h: 160, left: "20%", top: -10, blur: 10, dur: 17 },
        { w: "50%", h: 130, left: "40%", top: 5, blur: 8, dur: 22 },
        { w: "45%", h: 120, left: "55%", top: -5, blur: 9, dur: 19 },
        { w: "40%", h: 110, left: "-5%", top: 10, blur: 7, dur: 24 },
        { w: "35%", h: 100, left: "70%", top: 8, blur: 8, dur: 21 },
      ].map((c, i) => (
        <div
          key={`body-${i}`}
          style={{
            position: "absolute",
            left: c.left,
            top: c.top,
            width: c.w,
            height: c.h,
            borderRadius: "50%",
            background: `radial-gradient(ellipse at 50% 40%, rgba(${coreR},${coreG},${coreB},${d * 0.85}) 0%, rgba(${coreR - 15},${coreG - 15},${coreB - 10},${d * 0.6}) 45%, rgba(${coreR - 25},${coreG - 25},${coreB - 15},${d * 0.2}) 75%, transparent 100%)`,
            filter: `blur(${c.blur}px)`,
            animation: `cloudDrift ${c.dur}s ease-in-out ${i * 1.2}s infinite alternate`,
          }}
        />
      ))}

      {/* Bottom wisps — extend below, softer */}
      {[
        { w: "50%", h: 60, left: "10%", top: coverageHeight * 0.65, blur: 18 },
        { w: "55%", h: 50, left: "30%", top: coverageHeight * 0.7, blur: 22 },
        { w: "40%", h: 45, left: "50%", top: coverageHeight * 0.68, blur: 20 },
      ].map((c, i) => (
        <div
          key={`wisp-${i}`}
          style={{
            position: "absolute",
            left: c.left,
            top: c.top,
            width: c.w,
            height: c.h,
            borderRadius: "50%",
            background: `radial-gradient(ellipse, rgba(${coreR},${coreG},${coreB},${d * 0.35}) 0%, transparent 80%)`,
            filter: `blur(${c.blur}px)`,
            animation: `cloudDrift ${26 + i * 3}s ease-in-out ${i * 2}s infinite alternate`,
          }}
        />
      ))}

      {/* Light highlights on top — brighter patches for 3D depth */}
      {[
        { w: "30%", h: 60, left: "15%", top: -5 },
        { w: "25%", h: 50, left: "45%", top: -8 },
        { w: "20%", h: 45, left: "65%", top: 0 },
      ].map((c, i) => (
        <div
          key={`hl-${i}`}
          style={{
            position: "absolute",
            left: c.left,
            top: c.top,
            width: c.w,
            height: c.h,
            borderRadius: "50%",
            background: `radial-gradient(ellipse at 50% 30%, rgba(${coreR + 40},${coreG + 40},${coreB + 30},${d * 0.4}) 0%, transparent 70%)`,
            filter: "blur(8px)",
            animation: `cloudDrift ${23 + i * 3}s ease-in-out ${i * 1.5}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
};

/* ────────────────────── Fog Layers ────────────────────── */

const FogLayers: React.FC = () => {
  const hazeLayers = [
    {
      opacity: 0.18,
      anim: "fogDrift1 36s linear -8s infinite",
      bg: "radial-gradient(ellipse at 26% 38%, rgba(196,201,210,0.3) 0%, rgba(176,182,192,0.16) 42%, transparent 74%)",
    },
    {
      opacity: 0.14,
      anim: "fogDrift2 44s linear -18s infinite",
      bg: "radial-gradient(ellipse at 72% 54%, rgba(186,191,201,0.26) 0%, rgba(164,170,180,0.12) 46%, transparent 76%)",
    },
    {
      opacity: 0.16,
      anim: "fogDrift3 40s linear -4s infinite",
      bg: "radial-gradient(ellipse at 50% 66%, rgba(188,193,203,0.28) 0%, rgba(162,168,178,0.1) 54%, transparent 78%)",
    },
  ];

  const fogBanks = [
    {
      width: "46%",
      height: 220,
      top: "10%",
      left: "-34%",
      blur: 17,
      opacity: 0.56,
      anim: "fogBankSweep1 26s linear -6s infinite",
      bg: "radial-gradient(ellipse at 30% 48%, rgba(132,138,150,0.88) 0%, rgba(118,124,138,0.74) 34%, rgba(100,106,118,0.3) 66%, transparent 92%)",
      edgeBg:
        "radial-gradient(ellipse at 36% 50%, rgba(66,72,84,0) 44%, rgba(74,80,92,0.12) 62%, rgba(82,88,100,0.24) 76%, rgba(66,72,84,0) 92%)",
    },
    {
      width: "38%",
      height: 176,
      top: "30%",
      left: "-24%",
      blur: 14,
      opacity: 0.48,
      anim: "fogBankSweep2 32s linear -14s infinite",
      bg: "radial-gradient(ellipse at 40% 50%, rgba(122,128,140,0.82) 0%, rgba(108,114,126,0.68) 36%, rgba(88,94,106,0.26) 68%, transparent 92%)",
      edgeBg:
        "radial-gradient(ellipse at 42% 50%, rgba(64,70,82,0) 46%, rgba(72,78,90,0.1) 62%, rgba(78,84,96,0.22) 78%, rgba(64,70,82,0) 92%)",
    },
    {
      width: "54%",
      height: 248,
      top: "54%",
      left: "-40%",
      blur: 19,
      opacity: 0.58,
      anim: "fogBankSweep3 30s linear -11s infinite",
      bg: "radial-gradient(ellipse at 32% 52%, rgba(126,132,146,0.92) 0%, rgba(110,116,130,0.78) 34%, rgba(84,90,102,0.34) 66%, transparent 92%)",
      edgeBg:
        "radial-gradient(ellipse at 36% 54%, rgba(62,68,80,0) 44%, rgba(72,78,90,0.14) 60%, rgba(80,86,98,0.28) 76%, rgba(62,68,80,0) 92%)",
    },
    {
      width: "30%",
      height: 140,
      top: "70%",
      left: "-18%",
      blur: 12,
      opacity: 0.42,
      anim: "fogBankSweep1 22s linear -17s infinite",
      bg: "radial-gradient(ellipse at 38% 50%, rgba(118,124,136,0.82) 0%, rgba(102,108,120,0.66) 38%, rgba(80,86,96,0.24) 70%, transparent 92%)",
      edgeBg:
        "radial-gradient(ellipse at 40% 50%, rgba(60,66,78,0) 46%, rgba(68,74,86,0.08) 62%, rgba(76,82,94,0.2) 80%, rgba(60,66,78,0) 93%)",
    },
  ];

  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(170,176,186,0.08) 0%, rgba(150,156,168,0.1) 44%, rgba(128,134,146,0.16) 100%)",
        }}
      />
      {hazeLayers.map((layer, index) => (
        <div
          key={`fog-haze-${index}`}
          style={{
            position: "absolute",
            inset: "-6%",
            background: layer.bg,
            opacity: layer.opacity,
            animation: layer.anim,
            willChange: "transform",
          }}
        />
      ))}
      {fogBanks.map((bank, index) => (
        <div
          key={`fog-bank-${index}`}
          style={{
            position: "absolute",
            top: bank.top,
            left: bank.left,
            width: bank.width,
            height: bank.height,
            borderRadius: "50%",
            background: `${bank.edgeBg}, ${bank.bg}`,
            opacity: bank.opacity,
            filter: `blur(${bank.blur}px)`,
            animation: bank.anim,
            willChange: "transform",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 34%, rgba(92,98,110,0.06) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backdropFilter: "blur(0.7px)",
          WebkitBackdropFilter: "blur(0.7px)",
        }}
      />
    </>
  );
};

/* ────────────────── Heat Distortion ────────────────── */

const HeatDistortion: React.FC = () => {
  const refractionLayers = [
    {
      inset: "-8%",
      opacity: 0.92,
      animation: "heatRefractionBase 3.8s linear -1.6s infinite",
      backdrop: "blur(1.9px) saturate(1.18) brightness(1.06) contrast(1.08)",
      background:
        "linear-gradient(180deg, rgba(255,255,255,0.004) 0%, rgba(255,244,220,0.014) 56%, rgba(255,236,198,0.02) 100%)",
      mask: `
        radial-gradient(20% 15% at 12% 14%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.42) 54%, transparent 82%),
        radial-gradient(24% 18% at 33% 24%, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.34) 56%, transparent 82%),
        radial-gradient(22% 16% at 61% 18%, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.32) 54%, transparent 82%),
        radial-gradient(18% 14% at 84% 26%, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.3) 56%, transparent 82%),
        radial-gradient(26% 18% at 18% 48%, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.34) 54%, transparent 82%),
        radial-gradient(22% 16% at 46% 54%, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.36) 58%, transparent 84%),
        radial-gradient(20% 15% at 74% 50%, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.3) 54%, transparent 82%),
        radial-gradient(22% 16% at 90% 64%, rgba(0,0,0,0.84) 0%, rgba(0,0,0,0.24) 56%, transparent 84%),
        radial-gradient(28% 20% at 26% 84%, rgba(0,0,0,0.96) 0%, rgba(0,0,0,0.4) 56%, transparent 84%),
        radial-gradient(24% 18% at 58% 82%, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.34) 56%, transparent 84%),
        radial-gradient(20% 16% at 82% 86%, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.28) 58%, transparent 86%)
      `,
    },
    {
      inset: "-7%",
      opacity: 0.74,
      animation: "heatRefractionField1 4.4s linear -2.8s infinite",
      backdrop: "blur(1.6px) saturate(1.14) brightness(1.05) contrast(1.06)",
      background: "rgba(255,250,240,0.016)",
      mask: `
        radial-gradient(16% 12% at 8% 34%, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.26) 54%, transparent 82%),
        radial-gradient(18% 13% at 26% 12%, rgba(0,0,0,0.86) 0%, rgba(0,0,0,0.24) 54%, transparent 82%),
        radial-gradient(20% 14% at 44% 38%, rgba(0,0,0,0.86) 0%, rgba(0,0,0,0.26) 56%, transparent 84%),
        radial-gradient(16% 12% at 68% 12%, rgba(0,0,0,0.84) 0%, rgba(0,0,0,0.22) 54%, transparent 82%),
        radial-gradient(18% 13% at 88% 42%, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.2) 56%, transparent 84%),
        radial-gradient(24% 18% at 16% 66%, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.28) 56%, transparent 84%),
        radial-gradient(18% 13% at 40% 74%, rgba(0,0,0,0.86) 0%, rgba(0,0,0,0.24) 56%, transparent 84%),
        radial-gradient(22% 16% at 70% 68%, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.26) 58%, transparent 84%),
        radial-gradient(18% 13% at 92% 74%, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.18) 56%, transparent 84%)
      `,
    },
    {
      inset: "-6%",
      opacity: 0.62,
      animation: "heatRefractionField2 5.1s linear -4.4s infinite",
      backdrop: "blur(1.35px) saturate(1.12) brightness(1.04) contrast(1.05)",
      background: "rgba(255,248,230,0.014)",
      mask: `
        radial-gradient(14% 10% at 18% 24%, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.18) 52%, transparent 80%),
        radial-gradient(16% 11% at 38% 18%, rgba(0,0,0,0.76) 0%, rgba(0,0,0,0.18) 52%, transparent 80%),
        radial-gradient(14% 10% at 56% 34%, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.2) 54%, transparent 82%),
        radial-gradient(18% 12% at 78% 18%, rgba(0,0,0,0.74) 0%, rgba(0,0,0,0.16) 52%, transparent 80%),
        radial-gradient(14% 10% at 88% 56%, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.14) 54%, transparent 82%),
        radial-gradient(18% 12% at 10% 82%, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.2) 56%, transparent 82%),
        radial-gradient(16% 11% at 34% 88%, rgba(0,0,0,0.74) 0%, rgba(0,0,0,0.16) 54%, transparent 82%),
        radial-gradient(20% 13% at 60% 86%, rgba(0,0,0,0.76) 0%, rgba(0,0,0,0.18) 56%, transparent 84%),
        radial-gradient(16% 11% at 80% 80%, rgba(0,0,0,0.74) 0%, rgba(0,0,0,0.16) 54%, transparent 82%)
      `,
    },
    {
      inset: "-7%",
      opacity: 0.54,
      animation: "heatRefractionField3 5.8s linear -3.6s infinite",
      backdrop: "blur(1.45px) saturate(1.16) brightness(1.05) contrast(1.06)",
      background: "rgba(255,246,225,0.014)",
      mask: `
        radial-gradient(30% 22% at 24% 30%, rgba(0,0,0,0.86) 0%, rgba(0,0,0,0.2) 58%, transparent 86%),
        radial-gradient(26% 20% at 78% 24%, rgba(0,0,0,0.84) 0%, rgba(0,0,0,0.18) 58%, transparent 86%),
        radial-gradient(34% 24% at 48% 56%, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.22) 56%, transparent 86%),
        radial-gradient(28% 22% at 18% 78%, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.16) 58%, transparent 86%),
        radial-gradient(26% 20% at 82% 82%, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.14) 58%, transparent 86%)
      `,
    },
  ];

  return (
    <>
      {refractionLayers.map((layer, index) => (
        <div
          key={`heat-refraction-${index}`}
          style={{
            position: "absolute",
            inset: layer.inset,
            opacity: layer.opacity,
            background: layer.background,
            backdropFilter: layer.backdrop,
            WebkitBackdropFilter: layer.backdrop,
            maskImage: layer.mask,
            WebkitMaskImage: layer.mask,
            animation: layer.animation,
            pointerEvents: "none",
            willChange: "transform",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,220,150,0.01) 40%, rgba(255,214,135,0.022) 100%)",
        }}
      />
    </>
  );
};

/* ─────────────────── Frost Border ─────────────────── */

const Frost: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
    }}
  >
    {/* Ice frost — heavy inset shadows */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        boxShadow:
          "inset 0 0 60px 25px rgba(200,220,255,0.35), inset 0 0 120px 50px rgba(180,200,240,0.18), inset 0 0 200px 80px rgba(160,185,230,0.08)",
      }}
    />
    {/* Vignette */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse at 50% 50%, transparent 45%, rgba(210,225,255,0.2) 75%, rgba(190,210,245,0.35) 100%)",
      }}
    />
    {/* Corner frost patches */}
    {[
      { top: 0, left: 0, rotate: 0 },
      { top: 0, right: 0, rotate: 90 },
      { bottom: 0, right: 0, rotate: 180 },
      { bottom: 0, left: 0, rotate: 270 },
    ].map((pos, i) => (
      <div
        key={i}
        style={{
          position: "absolute",
          ...pos,
          width: 200,
          height: 200,
          background: `radial-gradient(circle at ${i < 2 ? "0%" : "100%"} ${i % 2 === 0 ? "0%" : "100%"}, rgba(220,235,255,0.25) 0%, transparent 60%)`,
          filter: "blur(10px)",
          rotate: undefined,
        }}
      />
    ))}
  </div>
);

/* ─────────────────── Lightning ─────────────────── */

function useLightning(active: boolean, reducedMotion: boolean) {
  const [flash, setFlash] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!active || reducedMotion) {
      setFlash(false);
      return;
    }

    const clearTimers = () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };

    const scheduleFlash = () => {
      const delay = 3000 + Math.random() * 5000;
      const t = setTimeout(() => {
        setFlash(true);
        const t2 = setTimeout(() => {
          setFlash(false);
          if (Math.random() < 0.4) {
            const t3 = setTimeout(() => {
              setFlash(true);
              const t4 = setTimeout(() => {
                setFlash(false);
                scheduleFlash();
              }, 80);
              timersRef.current.push(t4);
            }, 120);
            timersRef.current.push(t3);
          } else {
            scheduleFlash();
          }
        }, 80);
        timersRef.current.push(t2);
      }, delay);
      timersRef.current.push(t);
    };

    scheduleFlash();
    return clearTimers;
  }, [active, reducedMotion]);

  return flash;
}

/* ──────────────── transition layer ──────────────── */

interface TransitionLayerProps {
  weather: WeatherType;
  visible: boolean;
  reducedMotion: boolean;
}

const TransitionLayer: React.FC<TransitionLayerProps> = ({
  weather,
  visible,
  reducedMotion,
}) => {
  const lightningFlash = useLightning(
    weather === "storm" && visible,
    reducedMotion
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: visible ? 1 : 0,
        transition: "opacity 1.5s ease-in-out",
        pointerEvents: "none",
      }}
    >
      {/* ── clear ── */}
      {weather === "clear" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(255,240,200,0.05)",
            }}
          />
          <Sun />
          {!reducedMotion && <TyndallRays />}
        </>
      )}

      {/* ── rain ── */}
      {weather === "rain" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,15,0.12)",
            }}
          />
          {!reducedMotion && <Clouds darkness={0.55} coverageHeight={140} />}
          <CanvasLayer type="rain" reducedMotion={reducedMotion} />
        </>
      )}

      {/* ── snow ── */}
      {weather === "snow" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(200,210,230,0.08)",
            }}
          />
          {!reducedMotion && <Clouds darkness={0.3} coverageHeight={120} />}
          <CanvasLayer type="snow" reducedMotion={reducedMotion} />
        </>
      )}

      {/* ── storm ── */}
      {weather === "storm" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.28)",
            }}
          />
          {!reducedMotion && <Clouds darkness={0.9} coverageHeight={220} />}
          <CanvasLayer type="storm" reducedMotion={reducedMotion} />
          {lightningFlash && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(255,255,255,0.65)",
              }}
            />
          )}
        </>
      )}

      {/* ── fog ── */}
      {weather === "fog" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(164,170,180,0.08)",
            }}
          />
          {!reducedMotion ? (
            <FogLayers />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(180deg, rgba(184,190,200,0.2) 0%, rgba(146,152,164,0.24) 100%)",
              }}
            />
          )}
        </>
      )}

      {/* ── extreme_heat ── */}
      {weather === "extreme_heat" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(255,180,60,0.1)",
            }}
          />
          <Sun size={280} intensity={1.5} />
          {!reducedMotion && (
            <>
              <TyndallRays intense />
              <HeatDistortion />
            </>
          )}
        </>
      )}

      {/* ── extreme_cold ── */}
      {weather === "extreme_cold" && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(130,160,220,0.12)",
            }}
          />
          <Frost />
          <CanvasLayer type="extreme_cold_snow" reducedMotion={reducedMotion} />
        </>
      )}
    </div>
  );
};

/* ═══════════════════ MAIN COMPONENT ═══════════════════ */

export const WeatherOverlay: React.FC<WeatherOverlayProps> = ({ weather }) => {
  const reducedMotion = usePrefersReducedMotion();

  const weatherType = (
    [
      "clear",
      "rain",
      "fog",
      "storm",
      "snow",
      "extreme_heat",
      "extreme_cold",
    ].includes(weather)
      ? weather
      : "clear"
  ) as WeatherType;

  const [activeSlot, setActiveSlot] = useState<"A" | "B">("A");
  const [weatherA, setWeatherA] = useState<WeatherType>(weatherType);
  const [weatherB, setWeatherB] = useState<WeatherType>(weatherType);
  const prevWeatherRef = useRef(weatherType);

  useEffect(() => {
    if (weatherType !== prevWeatherRef.current) {
      prevWeatherRef.current = weatherType;
      if (activeSlot === "A") {
        setWeatherB(weatherType);
        setActiveSlot("B");
      } else {
        setWeatherA(weatherType);
        setActiveSlot("A");
      }
    }
  }, [weatherType, activeSlot]);

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
      <style>{`
        @keyframes sunPulse {
          0%, 100% { transform: scale(1); opacity: 0.88; }
          50% { transform: scale(1.05); opacity: 1; }
        }
        @keyframes haloRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes haloRotateReverse {
          from { transform: rotate(360deg); }
          to { transform: rotate(0deg); }
        }
        @keyframes raysFullRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes rayPulse {
          0% { opacity: 0.7; }
          100% { opacity: 1; }
        }
        @keyframes cloudDrift {
          0% { transform: translateX(0); }
          100% { transform: translateX(25px); }
        }
        @keyframes fogDrift1 {
          0% { transform: translate3d(-10%, -1%, 0) scale(0.98); }
          100% { transform: translate3d(12%, 1.5%, 0) scale(1.03); }
        }
        @keyframes fogDrift2 {
          0% { transform: translate3d(-14%, 1.5%, 0) scale(1.02); }
          100% { transform: translate3d(9%, -1%, 0) scale(1.05); }
        }
        @keyframes fogDrift3 {
          0% { transform: translate3d(-8%, 2%, 0) scale(0.96); }
          100% { transform: translate3d(14%, -1.5%, 0) scale(1.02); }
        }
        @keyframes fogBankSweep1 {
          0% { transform: translate3d(0, 0, 0) scale(0.94); }
          100% { transform: translate3d(165vw, -12px, 0) scale(1.05); }
        }
        @keyframes fogBankSweep2 {
          0% { transform: translate3d(0, 0, 0) scale(0.9); }
          100% { transform: translate3d(152vw, 10px, 0) scale(1.08); }
        }
        @keyframes fogBankSweep3 {
          0% { transform: translate3d(0, 0, 0) scale(0.96); }
          100% { transform: translate3d(172vw, -8px, 0) scale(1.03); }
        }
        @keyframes heatRefractionBase {
          0% { transform: translate3d(0, 0, 0) scale(1, 1) skewX(0deg); }
          20% { transform: translate3d(10px, -4px, 0) scale(1.03, 1.02) skewX(0.6deg); }
          45% { transform: translate3d(-9px, -11px, 0) scale(1.02, 0.98) skewX(-0.75deg); }
          70% { transform: translate3d(7px, -8px, 0) scale(1.04, 1.03) skewX(0.45deg); }
          100% { transform: translate3d(-6px, -15px, 0) scale(1.01, 1.02) skewX(-0.4deg); }
        }
        @keyframes heatRefractionField1 {
          0% { transform: translate3d(-10px, 0, 0) scale(0.98, 0.97) skewX(-0.45deg); }
          30% { transform: translate3d(13px, -7px, 0) scale(1.04, 1.01) skewX(0.7deg); }
          60% { transform: translate3d(-7px, -14px, 0) scale(1.02, 1.05) skewX(-0.6deg); }
          100% { transform: translate3d(10px, -18px, 0) scale(1.05, 1) skewX(0.35deg); }
        }
        @keyframes heatRefractionField2 {
          0% { transform: translate3d(7px, 0, 0) scale(1.01, 0.98) skewX(0.3deg); }
          25% { transform: translate3d(-9px, -9px, 0) scale(0.98, 1.03) skewX(-0.65deg); }
          58% { transform: translate3d(12px, -16px, 0) scale(1.05, 1.01) skewX(0.5deg); }
          100% { transform: translate3d(-6px, -12px, 0) scale(1.01, 1.04) skewX(-0.25deg); }
        }
        @keyframes heatRefractionField3 {
          0% { transform: translate3d(-4px, 0, 0) scale(0.99, 0.99) skewX(-0.25deg); }
          28% { transform: translate3d(11px, -6px, 0) scale(1.03, 1.03) skewX(0.55deg); }
          52% { transform: translate3d(-10px, -13px, 0) scale(1.01, 1.06) skewX(-0.7deg); }
          78% { transform: translate3d(8px, -10px, 0) scale(1.04, 0.99) skewX(0.4deg); }
          100% { transform: translate3d(-7px, -17px, 0) scale(1.02, 1.04) skewX(-0.35deg); }
        }
      `}</style>

      <TransitionLayer
        weather={weatherA}
        visible={activeSlot === "A"}
        reducedMotion={reducedMotion}
      />
      <TransitionLayer
        weather={weatherB}
        visible={activeSlot === "B"}
        reducedMotion={reducedMotion}
      />
    </div>
  );
};
