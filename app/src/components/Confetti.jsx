import { useEffect, useState, useCallback } from "react";

const COLORS = [
  "oklch(0.8 0.18 145)",  // green
  "oklch(0.8 0.18 250)",  // blue
  "oklch(0.85 0.16 85)",  // yellow
  "oklch(0.75 0.18 330)", // pink
  "oklch(0.8 0.16 200)",  // cyan
];

function randomBetween(a, b) {
  return Math.random() * (b - a) + a;
}

function Particle({ color, style }) {
  return (
    <div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: style.size,
        height: style.size,
        backgroundColor: color,
        left: style.x,
        top: style.y,
        animation: `confetti-fly ${style.duration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards`,
        "--tx": style.tx,
        "--ty": style.ty,
        "--r": style.r,
        opacity: 0.9,
      }}
    />
  );
}

/**
 * Confetti burst component.
 * Renders particles at a given position then auto-cleans up.
 *
 * Usage: <Confetti x={500} y={300} active={true} onDone={() => ...} />
 */
export function Confetti({ x = "50%", y = "50%", active, onDone, count = 24 }) {
  const [particles, setParticles] = useState([]);

  const burst = useCallback(() => {
    const ps = Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count + randomBetween(-0.3, 0.3);
      const velocity = randomBetween(40, 120);
      const size = randomBetween(4, 8);
      return {
        id: i,
        color: COLORS[i % COLORS.length],
        size,
        x: 0,
        y: 0,
        tx: `${Math.cos(angle) * velocity}px`,
        ty: `${Math.sin(angle) * velocity - randomBetween(20, 60)}px`,
        r: `${randomBetween(-180, 180)}deg`,
        duration: randomBetween(600, 1000),
      };
    });
    setParticles(ps);
    const maxDur = Math.max(...ps.map((p) => p.duration));
    setTimeout(() => {
      setParticles([]);
      onDone?.();
    }, maxDur + 50);
  }, [count, onDone]);

  useEffect(() => {
    if (active) burst();
  }, [active, burst]);

  if (particles.length === 0) return null;

  return (
    <div
      className="fixed pointer-events-none z-[100]"
      style={{ left: x, top: y, transform: "translate(-50%, -50%)" }}
    >
      {particles.map((p) => (
        <Particle key={p.id} color={p.color} style={p} />
      ))}
    </div>
  );
}

export default Confetti;
