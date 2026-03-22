import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

interface CanvasLayerProps {
  type: "rain" | "snow" | "storm" | "extreme_cold_snow";
  reducedMotion: boolean;
}

const CanvasLayer: React.FC<CanvasLayerProps> = ({ type, reducedMotion }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef(0);
  const snowTimeRef = useRef(0);

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

    if (type === "rain" || type === "storm") {
      const isStorm = type === "storm";
      for (const p of particles) {
        // Rain with slight width variation for depth
        const lineW = isStorm ? 1.5 : 1 + p.opacity * 0.5;
        ctx.strokeStyle = `rgba(180,210,255,${p.opacity})`;
        ctx.lineWidth = lineW;
        ctx.beginPath();
        const angle = isStorm ? 0.4 : 0.25;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.length * angle, p.y + p.length);
        ctx.stroke();
        p.y += p.speed;
        p.x += p.speed * angle;
        if (p.y > h) {
          p.y = -p.length - Math.random() * 40;
          p.x = Math.random() * w * 1.3 - w * 0.15;
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
    } else {
      // snow or extreme_cold_snow
      snowTimeRef.current += 0.012;
      const t = snowTimeRef.current;
      for (const p of particles) {
        const sx = p.x + Math.sin(t * p.swaySpeed + p.sway * 0.1) * p.sway;
        // Draw snowflake with soft edge
        const gradient = ctx.createRadialGradient(sx, p.y, 0, sx, p.y, p.radius);
        gradient.addColorStop(0, `rgba(255,255,255,${p.opacity})`);
        gradient.addColorStop(0.6, `rgba(255,255,255,${p.opacity * 0.6})`);
        gradient.addColorStop(1, `rgba(255,255,255,0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(sx, p.y, p.radius * 1.5, 0, Math.PI * 2);
        ctx.fill();
        p.y += p.speed;
        p.x += Math.sin(t * 0.3 + p.sway) * 0.15;
        if (p.y > h + p.radius * 2) {
          p.y = -p.radius * 3;
          p.x = Math.random() * w;
        }
      }
    }

    ctx.restore();
    rafRef.current = requestAnimationFrame(draw);
  }, [type]);

  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let resizeTimer: ReturnType<typeof setTimeout>;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const count =
        type === "storm" ? 500 : type === "rain" ? 250 : type === "snow" ? 180 : 60;
      if (type === "rain" || type === "storm") {
        particlesRef.current = initRainParticles(w, h, count);
      } else {
        particlesRef.current = initSnowParticles(w, h, count);
      }
    };

    const debouncedResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };

    resize();
    window.addEventListener("resize", debouncedResize);
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", debouncedResize);
      clearTimeout(resizeTimer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [type, reducedMotion, draw]);

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
  const coreR = Math.round(70 + (1 - d) * 80);  // 70 (dark/storm) – 150 (light/snow)
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
        { w: "55%", h: 140, left: "5%",   top: 0,   blur: 8,  dur: 20 },
        { w: "60%", h: 160, left: "20%",  top: -10, blur: 10, dur: 17 },
        { w: "50%", h: 130, left: "40%",  top: 5,   blur: 8,  dur: 22 },
        { w: "45%", h: 120, left: "55%",  top: -5,  blur: 9,  dur: 19 },
        { w: "40%", h: 110, left: "-5%",  top: 10,  blur: 7,  dur: 24 },
        { w: "35%", h: 100, left: "70%",  top: 8,   blur: 8,  dur: 21 },
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
        { w: "55%", h: 50, left: "30%", top: coverageHeight * 0.7,  blur: 22 },
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

const FogLayers: React.FC = () => (
  <>
    {[
      { opacity: 0.35, anim: "fogDrift1 20s ease-in-out infinite alternate",
        bg: "radial-gradient(ellipse at 30% 40%, rgba(210,210,220,0.6) 0%, rgba(190,190,205,0.3) 40%, transparent 70%)" },
      { opacity: 0.25, anim: "fogDrift2 30s ease-in-out infinite alternate",
        bg: "radial-gradient(ellipse at 70% 55%, rgba(200,200,215,0.55) 0%, rgba(185,185,200,0.25) 45%, transparent 70%)" },
      { opacity: 0.3, anim: "fogDrift3 25s ease-in-out infinite alternate",
        bg: "radial-gradient(ellipse at 50% 60%, rgba(205,205,218,0.5) 0%, rgba(188,188,200,0.2) 50%, transparent 65%)" },
      { opacity: 0.15, anim: "fogDrift1 35s ease-in-out 5s infinite alternate",
        bg: "radial-gradient(ellipse at 20% 70%, rgba(215,215,225,0.4) 0%, transparent 60%)" },
    ].map((layer, i) => (
      <div
        key={i}
        style={{
          position: "absolute",
          inset: 0,
          background: layer.bg,
          opacity: layer.opacity,
          animation: layer.anim,
        }}
      />
    ))}
    <div style={{
      position: "absolute",
      inset: 0,
      backdropFilter: "blur(1.5px)",
      WebkitBackdropFilter: "blur(1.5px)",
    }} />
  </>
);

/* ────────────────── Heat Distortion ────────────────── */

const HeatDistortion: React.FC = () => (
  <>
    <svg
      style={{ position: "absolute", width: 0, height: 0 }}
      aria-hidden="true"
    >
      <defs>
        <filter id="weather-heat-distortion">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.018"
            numOctaves={3}
            result="turbulence"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="turbulence"
            scale={14}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
    <div
      style={{
        position: "absolute",
        inset: 0,
        filter: "url(#weather-heat-distortion)",
        animation: "heatShimmer 8s ease-in-out infinite alternate",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "linear-gradient(0deg, rgba(255,120,0,0.05) 0%, transparent 50%)",
        }}
      />
    </div>
    {/* Rising heat streaks — more and wider */}
    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
      <div
        key={i}
        style={{
          position: "absolute",
          bottom: 0,
          left: `${8 + i * 13}%`,
          width: 4 + (i % 3),
          height: "50%",
          background:
            "linear-gradient(0deg, rgba(255,160,60,0.12) 0%, rgba(255,200,100,0.04) 50%, transparent 100%)",
          animation: `heatRise ${2.5 + i * 0.4}s ease-in-out ${i * 0.4}s infinite`,
          filter: "blur(2px)",
        }}
      />
    ))}
    {/* Bottom heat shimmer gradient */}
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "20%",
        background: "linear-gradient(0deg, rgba(255,180,80,0.06) 0%, transparent 100%)",
        animation: "heatShimmer 6s ease-in-out 2s infinite alternate",
      }}
    />
  </>
);

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
          <div style={{ position: "absolute", inset: 0, background: "rgba(255,240,200,0.05)" }} />
          <Sun />
          {!reducedMotion && <TyndallRays />}
        </>
      )}

      {/* ── rain ── */}
      {weather === "rain" && (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,15,0.12)" }} />
          {!reducedMotion && <Clouds darkness={0.55} coverageHeight={140} />}
          <CanvasLayer type="rain" reducedMotion={reducedMotion} />
        </>
      )}

      {/* ── snow ── */}
      {weather === "snow" && (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(200,210,230,0.08)" }} />
          {!reducedMotion && <Clouds darkness={0.3} coverageHeight={120} />}
          <CanvasLayer type="snow" reducedMotion={reducedMotion} />
        </>
      )}

      {/* ── storm ── */}
      {weather === "storm" && (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.28)" }} />
          {!reducedMotion && <Clouds darkness={0.9} coverageHeight={220} />}
          <CanvasLayer type="storm" reducedMotion={reducedMotion} />
          {lightningFlash && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.65)" }} />
          )}
        </>
      )}

      {/* ── fog ── */}
      {weather === "fog" && (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(180,185,195,0.12)" }} />
          {!reducedMotion ? (
            <FogLayers />
          ) : (
            <div style={{ position: "absolute", inset: 0, background: "rgba(200,200,210,0.3)" }} />
          )}
        </>
      )}

      {/* ── extreme_heat ── */}
      {weather === "extreme_heat" && (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(255,180,60,0.1)" }} />
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
          <div style={{ position: "absolute", inset: 0, background: "rgba(130,160,220,0.12)" }} />
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
    ["clear", "rain", "fog", "storm", "snow", "extreme_heat", "extreme_cold"].includes(weather)
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
          0% { transform: translateX(-50px); }
          100% { transform: translateX(50px); }
        }
        @keyframes fogDrift2 {
          0% { transform: translateX(40px); }
          100% { transform: translateX(-60px); }
        }
        @keyframes fogDrift3 {
          0% { transform: translateX(-30px); }
          100% { transform: translateX(45px); }
        }
        @keyframes heatRise {
          0% { transform: translateY(0); opacity: 0.8; }
          100% { transform: translateY(-150px); opacity: 0; }
        }
        @keyframes heatShimmer {
          0% { transform: translateY(0); }
          100% { transform: translateY(-8px); }
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
