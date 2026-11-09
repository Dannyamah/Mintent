// The pack opening. Tap the sealed pack, it tears, light bursts in the rarity's colour, and the card flips into your hands.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, insured, rarityOf, usd, units, type Card } from "./api";
import { PackArt } from "./Home";
import { CountUp, EASE, RarityBadge, Tilt } from "./ui";

type Stage = "sealed" | "tearing" | "revealed";

function Burst({ rarity }: { rarity: string }) {
  const count = rarity === "epic" ? 44 : rarity === "rare" ? 32 : rarity === "uncommon" ? 22 : 14;
  const bits = useMemo(() => Array.from({ length: count }, (_, i) => ({ a: (i / count) * 360 + Math.random() * 12, d: 180 + Math.random() * 300, s: 3 + Math.random() * 6, t: 0.8 + Math.random() * 0.8 })), [count]);
  return (
    <div className={`burst burst--${rarity}`} aria-hidden="true">
      <motion.span className="burst__flash" initial={{ scale: 0.2, opacity: 0.95 }} animate={{ scale: 3.4, opacity: 0 }} transition={{ duration: 1, ease: EASE }} />
      <motion.span className="burst__rays" initial={{ scale: 0.4, opacity: 0, rotate: -20 }} animate={{ scale: 1.5, opacity: [0, 0.8, 0.28], rotate: 40 }} transition={{ duration: 2.2, ease: EASE }} />
      {bits.map((b, i) => (
        <motion.i key={i} style={{ width: b.s, height: b.s }} initial={{ x: 0, y: 0, opacity: 1, scale: 1 }} animate={{ x: Math.cos((b.a * Math.PI) / 180) * b.d, y: Math.sin((b.a * Math.PI) / 180) * b.d, opacity: 0, scale: 0.3 }} transition={{ duration: b.t, ease: EASE }} />
      ))}
    </div>
  );
}

export function RevealPage({ tokenId }: { tokenId: string }) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const [stage, setStage] = useState<Stage>("sealed");
  const reduced = useReducedMotion();

  useEffect(() => {
    api.card(tokenId).then((c) => {
      setCard(c);
      if (c.image) {
        const img = new Image();
        img.onload = () => setImgReady(true);
        img.onerror = () => setImgReady(true);
        img.src = c.image;
      } else {
        setImgReady(true);
      }
    }, (e) => setError(e.message));
  }, [tokenId]);

  const rarity = rarityOf(card?.record.rarity);
  const canOpen = Boolean(card && imgReady);

  const open = () => {
    if (!canOpen || stage !== "sealed") return;
    setStage("tearing");
    setTimeout(() => setStage("revealed"), reduced ? 50 : 720);
  };

  return (
    <main className={`reveal reveal--${stage === "revealed" ? rarity : "sealed"}`}>
      <div className="aurora aurora--reveal" aria-hidden="true" />
      {error && <p className="error" role="alert">{error}</p>}

      <div className="reveal__stage">
        <AnimatePresence>
          {stage !== "revealed" && (
            <motion.button
              key="pack"
              className="reveal__pack"
              onClick={open}
              disabled={!canOpen}
              aria-label={canOpen ? "Tear open your pack" : "Getting your pack ready"}
              initial={{ scale: 0.7, opacity: 0, y: 40 }}
              animate={stage === "tearing" ? { scale: [1, 1.08, 1.2], rotate: [0, -3, 3, -4, 4, 0], opacity: [1, 1, 0] } : { scale: 1, opacity: 1, y: [0, -10, 0] }}
              transition={stage === "tearing" ? { duration: 0.72, ease: "easeIn" } : { y: { duration: 3, repeat: Infinity, ease: "easeInOut" }, default: { duration: 0.7, ease: EASE } }}
              exit={{ opacity: 0 }}
              whileHover={stage === "sealed" && canOpen ? { scale: 1.05, rotate: -1.5 } : undefined}
              whileTap={stage === "sealed" && canOpen ? { scale: 0.96 } : undefined}
            >
              <Tilt foil="pack" max={12}><PackArt price={Number(card?.record.pack_type.match(/\d+/)?.[0] ?? 0)} large /></Tilt>
            </motion.button>
          )}
        </AnimatePresence>

        {stage === "revealed" && card && (
          <>
            <Burst rarity={rarity} />
            <motion.div className="reveal__card" initial={{ rotateY: 180, scale: 0.55, y: 60 }} animate={{ rotateY: 0, scale: 1, y: 0 }} transition={{ type: "spring", stiffness: 90, damping: 14, mass: 1.1 }}>
              <Tilt foil={rarity} max={16}>
                <img src={card.image ?? undefined} alt={card.name ?? "Your graded card"} />
              </Tilt>
            </motion.div>
          </>
        )}
      </div>

      <div className="reveal__copy">
        {stage === "sealed" && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4, duration: 0.6 }}>
            <h1 className="display">{canOpen ? "Your pack is ready" : "Getting your pack ready…"}</h1>
            <p className="lede">{canOpen ? "Tap to tear it open." : "One moment."}</p>
          </motion.div>
        )}
        {stage === "revealed" && card && (
          <motion.div className="reveal__result" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.7, ease: EASE }}>
            <RarityBadge rarity={rarity} />
            <h1 className="display">{card.name ?? "Your card"}</h1>
            <p className="reveal__value"><CountUp value={insured(card)} format={(n) => usd(Math.round(n * 100) / 100)} /> <small>insured value</small></p>
            {card.offer && <p className="lede"><Sparkles size={15} aria-hidden="true" /> Collector Crypt will buy it back for {usd(units(card.offer.amountUnits))}.</p>}
            <div className="reveal__actions">
              <a className="btn btn--primary" href={`#/card/${tokenId}`}>View your card <ArrowRight size={16} aria-hidden="true" /></a>
              <a className="btn btn--ghost" href="#/dashboard">Your dashboard</a>
            </div>
          </motion.div>
        )}
      </div>
    </main>
  );
}
