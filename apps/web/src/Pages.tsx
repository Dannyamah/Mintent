// Pack detail, security explainer and not-found pages.
import { motion } from "motion/react";
import { ArrowLeft, Ban, Check, FileSearch, KeyRound, Lock, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api, usd, type Pack, type PackDetail } from "./api";
import { PackArt } from "./Home";
import { EASE, Reveal, Skeleton, Tilt } from "./ui";

export function PackPage({ code, onPick }: { code: string; onPick: (p: Pack) => void }) {
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.pack(code).then(setPack, (e) => setError(e.message));
  }, [code]);
  if (error) return <NotFound what="that pack" />;
  return (
    <main className="page">
      <a className="back" href="#/"><ArrowLeft size={15} aria-hidden="true" /> All packs</a>
      {!pack ? (
        <div className="card-page__grid"><Skeleton style={{ aspectRatio: "3 / 4.4", display: "block", borderRadius: 18 }} /><Skeleton style={{ height: 420, display: "block" }} /></div>
      ) : (
        <>
          <div className="card-page__grid pack-page">
            <motion.div initial={{ opacity: 0, scale: 0.9, rotate: -3 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 120, damping: 16 }}>
              <Tilt foil="pack" max={15}><PackArt price={pack.price} large /></Tilt>
            </motion.div>
            <div className="stack stack--lg">
              <header>
                <p className="kicker">One real graded card</p>
                <h1 className="display">{pack.name}</h1>
              </header>
              <dl className="facts">
                <div><dt>Price</dt><dd>{usd(pack.price)}</dd></div>
                <div><dt>Average insured value</dt><dd>{pack.expectedValue ? usd(Math.round(pack.expectedValue * 100) / 100) : "—"}</dd></div>
                <div><dt>Instant sell-back</dt><dd>{pack.buybackPct}%</dd></div>
              </dl>
              <div className="odds panel">
                <h2>The odds</h2>
                <ul>
                  {["epic", "rare", "uncommon", "common"].map((k, i) => (
                    <li key={k}>
                      <span className={`dot dot--${k}`} aria-hidden="true" />
                      <span>{k}</span>
                      <span className="odds__bar"><motion.i className={`seg--${k}`} initial={{ width: 0 }} animate={{ width: `${Math.max((pack.odds[k] ?? 0) * 100, 1.5)}%` }} transition={{ duration: 0.9, delay: i * 0.08, ease: EASE }} /></span>
                      <span className="tabular">{((pack.odds[k] ?? 0) * 100).toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
                <p className="hint">Most pulls are common and may be worth less than you paid. Each draw uses Collector Crypt's verifiable randomness, and you can check yours afterwards.</p>
              </div>
              <button className="btn btn--primary btn--glow btn--full" onClick={() => onPick(pack)}>Open a {usd(pack.price)} pack</button>
            </div>
          </div>
          {pack.recent.length > 0 && (
            <section className="band band--flush" aria-labelledby="recent-title">
              <Reveal><h2 id="recent-title" className="display display--sm">{pack.recentIsFromThisPack ? "Recent pulls from this pack" : "Recent pulls across all packs"}</h2></Reveal>
              <ul className="recent">
                {pack.recent.map((p, i) => (
                  <motion.li key={p.mint} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.04, duration: 0.5, ease: EASE }}>
                    <Tilt max={10} className="recent__art"><img src={p.thumb} alt={`${p.grader ?? "Graded"} card`} loading="lazy" onLoad={(e) => e.currentTarget.classList.add("is-loaded")} /></Tilt>
                    <span className="hint tabular">{usd(p.insuredValue)}</span>
                  </motion.li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

const THREATS: { icon: React.ReactNode; title: string; body: string }[] = [
  { icon: <Ban size={18} aria-hidden="true" />, title: "Sign first, sell later", body: "Once a card transfer has been signed, the NFT can't be sold until the outcome is settled. Any signature at all locks transfers for 5 minutes, longer than a Solana signature can stay usable." },
  { icon: <KeyRound size={18} aria-hidden="true" />, title: "Leaving a key under the mat", body: "The contract reads every Solana message before signing, and allows only known-safe instructions. A hidden delegate, an approval or a cheap listing that would survive a sale gets refused." },
  { icon: <Lock size={18} aria-hidden="true" />, title: "A signature that never expires", body: "Durable nonces are allowed only on Mintent's own accounts, which also need our signature. We re-check who owns the NFT before giving it." },
  { icon: <FileSearch size={18} aria-hidden="true" />, title: "Paying us with a fake success", body: "We prove every payment on Solana before minting anything, rather than trusting an API's word. One payment can't pay for two orders." },
  { icon: <ShieldAlert size={18} aria-hidden="true" />, title: "A compromised partner", body: "Before our treasury signs a purchase, it checks the transaction does exactly one thing: pay the pack price. Anything else is refused." },
];

export function SecurityPage() {
  return (
    <main className="page page--narrow">
      <a className="back" href="#/"><ArrowLeft size={15} aria-hidden="true" /> Home</a>
      <Reveal>
        <p className="kicker">Security</p>
        <h1 className="display">What stops a seller keeping the card?</h1>
        <p className="lede">A Solana signature outlives the NEAR state that authorised it. So “only the current owner can sign” isn't enough: a seller could sign first and sell afterwards. We proved that attack against our own earlier contract, then built these defences.</p>
      </Reveal>
      <ul className="threats">
        {THREATS.map((t, i) => (
          <Reveal key={t.title} delay={i * 0.05}>
            <li className="threat panel">
              <span className="threat__icon">{t.icon}</span>
              <div>
                <h2>{t.title}</h2>
                <p>{t.body}</p>
              </div>
            </li>
          </Reveal>
        ))}
      </ul>
      <Reveal className="panel limits">
        <h2><Check size={18} aria-hidden="true" /> What you still rely on</h2>
        <ul>
          <li>Collector Crypt holds the physical card and issued the Solana NFT.</li>
          <li>NEAR's signing network signs only what the contract asks.</li>
          <li>Mintent's relayer is trusted for its own treasury and for records, but not for your card. It can't move it.</li>
          <li>Insured value is Collector Crypt's reference price, not a market price.</li>
        </ul>
      </Reveal>
    </main>
  );
}

export function NotFound({ what = "that page" }: { what?: string }) {
  return (
    <main className="page">
      <div className="empty empty--center">
        <h1 className="display">We can't find {what}</h1>
        <a className="btn btn--primary" href="#/">Back to the packs</a>
      </div>
    </main>
  );
}
