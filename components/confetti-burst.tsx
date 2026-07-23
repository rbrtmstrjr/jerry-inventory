"use client";

import * as React from "react";

const COLORS = [
  "#ec4899", // pink
  "#d946ef", // fuchsia
  "#a855f7", // purple
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#22c55e", // green
  "#38bdf8", // sky
];

/** Deterministic pseudo-random in [0,1) — same on server and client, so the
 *  confetti renders identically both places (no hydration mismatch) without a
 *  client-only effect. */
function rand(i: number, salt: number) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Decorative exploding-confetti overlay — pure CSS animation (transform +
 * opacity only, GPU-friendly), no dependency. Pieces burst outward from the
 * centre on desynced infinite loops so it reads as a continuous celebration.
 * The global prefers-reduced-motion rule caps it to one instant frame (off).
 */
export function ConfettiBurst({ count = 44 }: { count?: number }) {
  const pieces = React.useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = rand(i, 1) * Math.PI * 2;
        const dist = 60 + rand(i, 2) * 340;
        const size = 5 + rand(i, 3) * 7;
        return {
          id: i,
          style: {
            "--cx": `${Math.round(Math.cos(angle) * dist)}px`,
            "--cy": `${Math.round(Math.sin(angle) * dist - 40)}px`,
            "--rot": `${Math.round(rand(i, 4) * 900 - 450)}deg`,
            "--dur": `${(1.6 + rand(i, 5) * 1.6).toFixed(2)}s`,
            "--delay": `${(rand(i, 6) * 2.4).toFixed(2)}s`,
            width: `${size.toFixed(1)}px`,
            height: `${(size * (rand(i, 7) > 0.5 ? 1 : 1.8)).toFixed(1)}px`,
            background: COLORS[i % COLORS.length],
            borderRadius: rand(i, 8) > 0.6 ? "9999px" : "1px",
          } as React.CSSProperties,
        };
      }),
    [count]
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {pieces.map((p) => (
        <span key={p.id} className="confetti-piece" style={p.style} />
      ))}
    </div>
  );
}
