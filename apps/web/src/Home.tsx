import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Ban, Check, ChevronDown, Lock, PackageOpen, ShieldCheck, Truck, Wallet } from "lucide-react";
import { Fragment, useState } from "react";
import { timeAgo, usd, type Pack, type Pull } from "./api";
import { Gallery } from "./Gallery";
import { EASE, Reveal, Skeleton, Tilt } from "./ui";

function Headline() {
  const words = [["Every", 0], ["pull", 0], ["in", 0], ["Near", 1], ["Mintent", 1], ["condition", 0]] as const;
  return (
    <h1 id="hero-title" className="hero__title">
      {words.map(([w, accent], i) => (
        <Fragment key={w}>
          <span className="word">
            <motion.span className={accent ? "word__in accent" : "word__in"} initial={{ y: "110%", rotate: 4 }} animate={{ y: 0, rotate: 0 }} transition={{ duration: 0.9, delay: 0.25 + i * 0.07, ease: EASE }}>
              {w}
            </motion.span>
          </span>{" "}
        </Fragment>
      ))}
    </h1>
  );
}

function Ticker({ pulls }: { pulls: Pull[] }) {
  if (pulls.length < 6) return null;
  const list = pulls.slice(0, 24);
  return (
    <section className="ticker" aria-label="Recent real pulls from Collector Crypt's public feed">
      <div className="ticker__track">
        {[...list, ...list].map((p, i) => (
          <span className="ticker__item" key={`${p.mint}-${i}`} aria-hidden={i >= list.length}>
            <img src={p.thumb} alt="" loading="lazy" />
            <span>
              <strong>{p.grader} {p.grade?.replace(/^.*?(\d+(\.\d+)?)$/, "$1")}</strong>
              <small>{usd(p.insuredValue)} · {timeAgo(p.at)}</small>
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

export function PackArt({ price, large }: { price: number; large?: boolean }) {
  return (
    <div className={`pack-art ${large ? "pack-art--large" : ""}`} aria-hidden="true">
      <span className="pack-art__crimp" />
      <span className="pack-art__logo">Mintent</span>
      <span className="pack-art__price">{price > 0 ? usd(price) : " "}</span>
      <span className="pack-art__sub">One graded card</span>
      <span className="pack-art__crimp pack-art__crimp--bottom" />
    </div>
  );
}

function OddsBar({ odds }: { odds: Record<string, number> }) {
  return (
    <div className="oddsbar" role="img" aria-label={Object.entries(odds).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ")}>
      {["common", "uncommon", "rare", "epic"].map((k) => (
        <span key={k} className={`oddsbar__seg oddsbar__seg--${k}`} style={{ flexGrow: Math.max((odds[k] ?? 0) * 100, 1.5) }} />
      ))}
    </div>
  );
}

function Shop({ packs, onPick }: { packs: Pack[]; onPick: (p: Pack) => void }) {
  return (
    <section id="packs" className="band" aria-labelledby="packs-title">
      <Reveal>
        <p className="kicker">The packs</p>
        <h2 id="packs-title" className="display">Choose your pull</h2>
        <p className="lede">One real graded card in every pack. Sell it back while the offer lasts, or keep it.</p>
      </Reveal>
      <ul className="packs">
        {packs.length === 0 && [0, 1, 2, 3].map((i) => <li key={i}><Skeleton style={{ height: 420, display: "block", borderRadius: 24 }} /></li>)}
        {packs.slice(0, 8).map((p, i) => (
          <motion.li key={p.code} initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.7, delay: i * 0.07, ease: EASE }}>
            <div className="pack-card">
              <a href={`#/packs/${p.code}`} className="pack-card__art" aria-label={`Details of the ${p.name}`}>
                <Tilt foil="pack" max={14} className="pack-card__tilt"><PackArt price={p.price} /></Tilt>
              </a>
              <div className="pack-card__body">
                <OddsBar odds={p.odds} />
                <dl className="pack-card__facts">
                  <div><dt>Average insured value</dt><dd>{p.expectedValue ? usd(Math.round(p.expectedValue * 100) / 100) : "—"}</dd></div>
                  <div><dt>Instant sell-back</dt><dd>{p.buybackPct}%</dd></div>
                </dl>
                <button className="btn btn--primary btn--full" onClick={() => onPick(p)}>Open a {usd(p.price)} pack</button>
              </div>
            </div>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

const CHIPS = ["BTC", "SOL", "ETH", "USDC", "USDT", "DOGE", "XRP", "ZEC", "SUI", "NEAR", "LTC", "ARB"];

function Bento() {
  return (
    <section id="how" className="band" aria-labelledby="how-title">
      <Reveal>
        <p className="kicker">How ownership works</p>
        <h2 id="how-title" className="display">An NFT that really holds the card</h2>
      </Reveal>
      <div className="bento">
        <Reveal className="bento__cell bento__cell--a">
          <div className="chips" aria-hidden="true">
            {[0, 1].map((row) => (
              <div className={`chips__row ${row ? "chips__row--rev" : ""}`} key={row}>
                {[...CHIPS, ...CHIPS].map((c, i) => <span className="chip" key={`${c}-${i}`}>{c}</span>)}
              </div>
            ))}
          </div>
          <h3>Pay from what you already hold</h3>
          <p>Bitcoin, Solana, Ethereum, stablecoins and more, through NEAR Intents. No bridge, and no Solana wallet to set up.</p>
        </Reveal>
        <Reveal className="bento__cell bento__cell--b" delay={0.08}>
          <div className="flowline" aria-hidden="true">
            <span className="node node--near">NEAR NFT</span>
            <span className="flowline__wire"><i /></span>
            <span className="node">Solana address</span>
            <span className="flowline__wire"><i /></span>
            <span className="node node--card">Graded card</span>
          </div>
          <h3>Sell the NFT, and the card goes with it</h3>
          <p>Your NFT controls its own Solana address through NEAR's signing network, and the real card sits there. Hand over the NFT and control moves in one NEAR transaction. Nothing moves on Solana.</p>
        </Reveal>
        <Reveal className="bento__cell bento__cell--c" delay={0.12}>
          <div className="attack" aria-hidden="true">
            <span className="attack__step"><Check size={16} /> Seller signs a transfer</span>
            <span className="attack__step attack__step--blocked"><Ban size={16} /> Seller tries to sell the NFT</span>
            <span className="attack__lock"><Lock size={15} /> Locked by the contract</span>
          </div>
          <h3>A sale can't be cheated</h3>
          <p>A seller can't get a transfer signed and then sell you an empty NFT. We proved that attack on a live contract, then made the contract refuse it. Run it yourself.</p>
          <a className="link-arrow" href="#/security">Read the threat model <ArrowRight size={15} aria-hidden="true" /></a>
        </Reveal>
        <Reveal className="bento__cell bento__cell--d" delay={0.16}>
          <ul className="exits">
            <li><Wallet size={18} aria-hidden="true" /><span><strong>Sell back</strong><small>Instant USDC while the offer lasts</small></span></li>
            <li><PackageOpen size={18} aria-hidden="true" /><span><strong>Hand it on</strong><small>Transfer the NFT to anyone on NEAR</small></span></li>
            <li><Truck size={18} aria-hidden="true" /><span><strong>Get the real slab</strong><small>Withdraw to your wallet, redeem on Collector Crypt</small></span></li>
          </ul>
          <h3>Your exits are real</h3>
        </Reveal>
      </div>
    </section>
  );
}

function ProofBand() {
  const checks = ["The NFT's owner on NEAR", "The address NEAR's signing network derives", "Who holds the card on Solana right now", "Collector Crypt's randomness proof for the draw"];
  return (
    <section className="band" aria-labelledby="proof-title">
      <div className="proofband">
        <Reveal>
          <p className="kicker">Don't trust us</p>
          <h2 id="proof-title" className="display">Check any pull yourself</h2>
          <p className="lede">One command, using public data only. It trusts nothing from Mintent.</p>
          <a className="link-arrow" href="#/security">How we keep it honest <ArrowRight size={15} aria-hidden="true" /></a>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="terminal">
            <div className="terminal__bar" aria-hidden="true"><i /><i /><i /></div>
            <code className="terminal__cmd">$ pnpm verify:pull &lt;contract&gt; &lt;token&gt;</code>
            <ul>
              {checks.map((c, i) => (
                <motion.li key={c} initial={{ opacity: 0, x: -12 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: 0.3 + i * 0.28, duration: 0.5, ease: EASE }}>
                  <ShieldCheck size={15} aria-hidden="true" /> PASS <span>{c}</span>
                </motion.li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const FAQ: [string, string][] = [
  ["What do I actually get?", "A real graded card, stored in a professional vault by Collector Crypt, plus a NEAR NFT that controls it. Most pulls are common and can be worth less than you paid: the odds and the average value are shown before you pay."],
  ["What does Mintent charge?", "1% on top of the pack price. You also pay normal network costs on the chain you pay from. There's no fee to sell back, transfer or withdraw through Mintent, though Collector Crypt charges shipping if you redeem a card."],
  ["How do I get the physical card?", "Withdraw the card to your own Solana wallet, then redeem it on Collector Crypt's site like any holder. That last step needs a Solana wallet. Buying, holding, transferring and selling back don't."],
  ["Is the draw fair?", "Each draw uses Collector Crypt's verifiable randomness, recorded on-chain, and every card page links to its public verifier. Mintent can't influence the result."],
  ["Who holds my money and my card?", "Your card sits at an address only your NFT can control, and Mintent can't move it. Collector Crypt holds the physical card and issued the NFT on Solana, so you do rely on them for that."],
  ["Is Mintent part of Collector Crypt?", "No. Mintent is an independent project that uses Collector Crypt's public APIs. Packs are Collector Crypt's."],
  ["Is this gambling?", "Paid random packs are regulated differently around the world, and they're not for everyone. You must be 18 or over. Only spend what you're happy to lose."],
];

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="band band--narrow" aria-labelledby="faq-title">
      <Reveal><h2 id="faq-title" className="display">Good questions</h2></Reveal>
      <ul className="faq">
        {FAQ.map(([q, a], i) => (
          <li key={q}>
            <button aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              {q}
              <motion.span animate={{ rotate: open === i ? 180 : 0 }} transition={{ duration: 0.25 }}><ChevronDown size={18} aria-hidden="true" /></motion.span>
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: EASE }} className="faq__body">
                  <p>{a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Home({ pulls, packs, onPick }: { pulls: Pull[]; packs: Pack[]; onPick: (p: Pack) => void }) {
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  return (
    <main>
      <Gallery pulls={pulls}>
        <div className="hero__copy">
          <Headline />
          <motion.p className="hero__sub" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8, duration: 0.7, ease: EASE }}>
            Real graded cards, paid from any chain, and owned as a NEAR NFT that holds the card.
          </motion.p>
          <motion.div className="hero__cta" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.95, duration: 0.7, ease: EASE }}>
            <button className="btn btn--primary btn--glow" onClick={() => go("packs")}>Open a pack <ArrowRight size={17} aria-hidden="true" /></button>
            <button className="btn btn--ghost" onClick={() => go("how")}>How it works</button>
          </motion.div>
        </div>
      </Gallery>
      <p className="hero__source">Every card on this wall is a real recent pull from Collector Crypt's public feed. Mintent is independent and not affiliated with Collector Crypt.</p>
      <Ticker pulls={pulls} />
      <Shop packs={packs} onPick={onPick} />
      <Bento />
      <ProofBand />
      <Faq />
    </main>
  );
}
