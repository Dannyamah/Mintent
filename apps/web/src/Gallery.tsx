// The hero: a curved wall of real graded cards framing the headline. The wall leans around the headline, tiles cascade
// in from the centre, and the wall shifts with depth as the pointer moves. Every tile is a real pull from a public feed,
// loaded at runtime. No card art ships with the app, and tiles identify a card by grade and value only.
import { motion, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usd, type Pull } from "./api";
import { EASE } from "./ui";

const ROWS = 4;
const WIDE = 1200;

function useColumns(): number {
  const [cols, setCols] = useState(() => (window.innerWidth >= WIDE ? 10 : 8));
  useEffect(() => {
    const on = () => setCols(window.innerWidth >= WIDE ? 10 : 8);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return cols;
}

function Tile({ pull, col, row, cols, distance, mx, my }: { pull?: Pull; col: number; row: number; cols: number; distance: number; mx: MotionValue<number>; my: MotionValue<number> }) {
  const centerCol = (cols - 1) / 2;
  const leanY = (col - centerCol) * -3.2; // the wall curves around the headline
  const leanX = (row - (ROWS - 1) / 2) * 3.6;
  const depth = 5 + distance * 3.2; // further from the centre moves more, like a nearer layer
  const x = useTransform(mx, (v) => v * depth);
  const y = useTransform(my, (v) => v * depth * 0.7);
  const label = pull ? `${pull.grader ?? "Graded"} ${pull.grade ?? ""} card, insured value ${usd(pull.insuredValue)}`.replace(/\s+/g, " ") : undefined;
  return (
    <motion.div className="wall__cell" style={{ gridColumn: col + 1, gridRow: row + 1, x, y }}>
      <motion.div className="tile-float" initial={{ opacity: 0, scale: 0.72, rotateY: leanY * 3, rotateX: leanX * 3, y: 34 }} animate={{ opacity: 1, scale: 1, rotateY: leanY, rotateX: leanX, y: 0 }} transition={{ duration: 0.95, ease: EASE, delay: 0.12 + distance * 0.075 }}>
        {pull ? (
          <motion.a className="tile" href={pull.url ?? undefined} target="_blank" rel="noreferrer" aria-label={label} whileHover={{ scale: 1.13, zIndex: 10, transition: { type: "spring", stiffness: 300, damping: 22 } }} whileTap={{ scale: 1.04 }}>
            <img
              src={pull.thumb}
              alt=""
              decoding="async"
              onLoad={(e) => e.currentTarget.classList.add("is-loaded")}
              onError={(e) => {
                // Resized copy failed: try the original once, then leave the quiet placeholder.
                if (e.currentTarget.src !== pull.image) e.currentTarget.src = pull.image;
              }}
            />
            <span className="tile__sheen" aria-hidden="true" />
            <span className="tile__tag">
              {pull.grader} {pull.grade?.replace(/^.*?(\d+(\.\d+)?)$/, "$1")} · {usd(pull.insuredValue)}
            </span>
          </motion.a>
        ) : (
          <div className="tile tile--empty" aria-hidden="true" />
        )}
      </motion.div>
    </motion.div>
  );
}

export function Gallery({ pulls, children }: { pulls: Pull[]; children: ReactNode }) {
  const cols = useColumns();
  const hero = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const mx = useSpring(rawX, { stiffness: 60, damping: 18 });
  const my = useSpring(rawY, { stiffness: 60, damping: 18 });
  const { scrollYProgress } = useScroll({ target: hero, offset: ["start start", "end start"] });
  const wallScale = useTransform(scrollYProgress, [0, 1], reduced ? [1, 1] : [1, 1.14]);
  const wallOpacity = useTransform(scrollYProgress, [0, 0.85], reduced ? [1, 1] : [1, 0.05]);
  const centreY = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [0, 90]);

  // Highest values sit closest to the headline, so the eye lands on the best cards first.
  const cells = useMemo(() => {
    const ranked = [...pulls].sort((a, b) => b.insuredValue - a.insuredValue);
    const positions: { col: number; row: number; distance: number }[] = [];
    const inCentre = (col: number, row: number) => row >= 1 && row <= 2 && col >= 2 && col <= cols - 3;
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < cols; col++) if (!inCentre(col, row)) positions.push({ col, row, distance: Math.hypot(col - (cols - 1) / 2, (row - 1.5) * 1.4) });
    return positions.sort((a, b) => a.distance - b.distance).map((p, i) => ({ ...p, pull: ranked[i] }));
  }, [pulls, cols]);

  return (
    <section
      ref={hero}
      className="hero"
      aria-labelledby="hero-title"
      onPointerMove={(e) => {
        if (reduced || e.pointerType !== "mouse") return;
        rawX.set((e.clientX / window.innerWidth - 0.5) * -2);
        rawY.set((e.clientY / window.innerHeight - 0.5) * -2);
      }}
    >
      <div className="aurora" aria-hidden="true" />
      <motion.div className="wall" style={{ "--cols": cols, scale: wallScale, opacity: wallOpacity } as never}>
        {cells.map((c) => (
          <Tile key={`${c.col}-${c.row}`} pull={c.pull} col={c.col} row={c.row} cols={cols} distance={c.distance} mx={mx} my={my} />
        ))}
        <motion.div className="wall__centre" style={{ gridColumn: `3 / ${cols - 1}`, y: centreY }}>
          {children}
        </motion.div>
      </motion.div>
    </section>
  );
}
