// Shared motion and UI pieces.
import { animate, AnimatePresence, motion, useInView, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { Check, Copy, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Rarity } from "./api";

export const SPRING = { type: "spring", stiffness: 260, damping: 26 } as const;
export const EASE = [0.2, 0.7, 0.2, 1] as const;

/** Fade and rise into view on scroll. */
export function Reveal({ children, delay = 0, y = 24, className, style }: { children: ReactNode; delay?: number; y?: number; className?: string; style?: CSSProperties }) {
  return (
    <motion.div className={className} style={style} initial={{ opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.7, delay, ease: EASE }}>
      {children}
    </motion.div>
  );
}

/** A number that counts up when it comes into view. */
export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduced = useReducedMotion();
  const last = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !inView) return;
    if (reduced) {
      el.textContent = format(value);
      return;
    }
    const controls = animate(last.current, value, { duration: 1.1, ease: EASE, onUpdate: (v) => (el.textContent = format(v)) });
    last.current = value;
    return () => controls.stop();
  }, [value, inView, reduced, format]);
  return <span ref={ref} className="tabular">{format(0)}</span>;
}

/** 3D tilt that follows the pointer, with a moving highlight. `foil` adds a holographic sheen. */
export function Tilt({ children, max = 12, foil, className, style }: { children: ReactNode; max?: number; foil?: Rarity | "pack"; className?: string; style?: CSSProperties }) {
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const reduced = useReducedMotion();
  const rx = useSpring(useTransform(py, [0, 1], [max, -max]), { stiffness: 220, damping: 22 });
  const ry = useSpring(useTransform(px, [0, 1], [-max, max]), { stiffness: 220, damping: 22 });
  const gx = useTransform(px, [0, 1], ["0%", "100%"]);
  const gy = useTransform(py, [0, 1], ["0%", "100%"]);
  const glare = useMotionTemplate`radial-gradient(circle at ${gx} ${gy}, rgba(255,255,255,.34), rgba(255,255,255,0) 55%)`;
  const shift = useMotionTemplate`${gx} ${gy}`;
  const [active, setActive] = useState(false);
  return (
    <motion.div
      className={`tilt ${className ?? ""}`}
      style={{ ...style, rotateX: reduced ? 0 : rx, rotateY: reduced ? 0 : ry, transformPerspective: 900 }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        px.set((e.clientX - r.left) / r.width);
        py.set((e.clientY - r.top) / r.height);
        setActive(true);
      }}
      onPointerLeave={() => {
        px.set(0.5);
        py.set(0.5);
        setActive(false);
      }}
    >
      {children}
      {foil && <motion.span className={`foil foil--${foil}`} style={{ backgroundPosition: shift, opacity: active ? 1 : 0.35 }} aria-hidden="true" />}
      <motion.span className="glare" style={{ background: glare, opacity: active ? 1 : 0 }} aria-hidden="true" />
    </motion.div>
  );
}

export function Skeleton({ style, className }: { style?: CSSProperties; className?: string }) {
  return <span className={`skeleton ${className ?? ""}`} style={style} aria-hidden="true" />;
}

export function RarityBadge({ rarity }: { rarity: Rarity }) {
  return <span className={`rarity rarity--${rarity}`}>{rarity}</span>;
}

// ---------- toasts ----------

interface Toast { id: number; text: string; kind: "ok" | "error" }
const ToastContext = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const add = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3200);
  }, []);
  return (
    <ToastContext.Provider value={add}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} layout className={`toast toast--${t.kind}`} initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={SPRING}>
              {t.kind === "ok" ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const toast = useToast();
  return (
    <button
      className={`icon-btn ${className ?? ""}`}
      aria-label={label}
      title={label}
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        toast("Copied");
      }}
    >
      <Copy size={16} aria-hidden="true" />
    </button>
  );
}

// ---------- sheet ----------

export function Sheet({ children, onClose, labelledBy, wide }: { children: ReactNode; onClose: () => void; labelledBy: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    document.body.classList.add("no-scroll");
    ref.current?.focus();
    return () => {
      window.removeEventListener("keydown", on);
      document.body.classList.remove("no-scroll");
    };
  }, [onClose]);
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={`sheet ${wide ? "sheet--wide" : ""}`} initial={{ opacity: 0, y: 36, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.98 }} transition={SPRING}>
        {children}
      </motion.div>
    </motion.div>
  );
}

/** Tick once a second, for countdowns and elapsed time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
