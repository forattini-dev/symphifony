import { useEffect, useRef, useCallback } from "react";

/**
 * Animated floating music notes and conductor particles.
 * Renders on a full-viewport canvas behind wizard content.
 */
export default function OnboardingParticles() {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const rafRef = useRef(null);

  const SYMBOLS = ["\u266A", "\u266B", "\u2669", "\u266C", "\u2605", "\u25CF"];
  const COLORS = [
    "oklch(0.75 0.15 250 / 0.35)",
    "oklch(0.80 0.14 200 / 0.30)",
    "oklch(0.70 0.18 330 / 0.25)",
    "oklch(0.85 0.12 85 / 0.30)",
    "oklch(0.75 0.16 145 / 0.28)",
    "oklch(0.80 0.10 280 / 0.22)",
  ];

  const createParticle = useCallback((w, h) => {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.4,
      vy: -Math.random() * 0.3 - 0.1,
      size: Math.random() * 16 + 10,
      symbol: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 0.8,
      opacity: Math.random() * 0.4 + 0.15,
      pulseOffset: Math.random() * Math.PI * 2,
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.scale(dpr, dpr);
    };
    resize();

    const count = Math.min(Math.floor((window.innerWidth * window.innerHeight) / 18000), 40);
    particlesRef.current = Array.from({ length: count }, () =>
      createParticle(window.innerWidth, window.innerHeight)
    );

    const animate = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      const now = Date.now() / 1000;

      for (const p of particlesRef.current) {
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;

        if (p.y < -30) { p.y = h + 30; p.x = Math.random() * w; }
        if (p.x < -30) p.x = w + 30;
        if (p.x > w + 30) p.x = -30;

        const pulse = Math.sin(now * 1.5 + p.pulseOffset) * 0.15 + 0.85;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = p.opacity * pulse;
        ctx.font = `${p.size}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = p.color;
        ctx.fillText(p.symbol, 0, 0);
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [createParticle]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
}
