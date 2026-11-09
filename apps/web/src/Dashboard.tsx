// Your vault: what you hold and what it's worth, what needs action, orders in flight, and everything that has happened.
// Every number is read live from NEAR, Solana and Collector Crypt. Nothing is estimated.
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeftRight, ArrowRight, Clock, ExternalLink, Package, PackageOpen, Timer, Truck, Wallet as WalletIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, insured, rarityOf, short, solanaTx, statusLabel, timeAgo, timeLeft, units, usd, type ActiveOrder, type ActivityItem, type Card, type Dashboard as Data, type Health, type Rarity } from "./api";
import { CopyButton, CountUp, EASE, Reveal, Skeleton, Tilt } from "./ui";
import { chainLabel } from "./Checkout";
import type { Wallet } from "./wallet";

const money = (n: number) => usd(Math.round(n * 100) / 100);
type Filter = "all" | "held" | "sold" | "out";
const FILTERS: [Filter, string][] = [["all", "All"], ["held", "Holding"], ["sold", "Sold back"], ["out", "Withdrawn"]];
type Sort = "newest" | "value";
const ORDER_LABEL: Record<string, string> = { awaiting_payment: "Waiting for your payment", paid: "Minting your NFT", minted: "Buying your pack", purchased: "Drawing your card", needs_attention: "Delayed. We keep retrying automatically" };
const RARITIES: Rarity[] = ["epic", "rare", "uncommon", "common"];

function isHeld(c: Card) {
  return c.record.status === "Opened" && c.heldByToken;
}

function Tile({ c, i }: { c: Card; i: number }) {
  const rarity = rarityOf(c.record.rarity);
  const expires = c.offer ? timeLeft(c.offer.expiresAt) : null;
  return (
    <motion.li layout initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.45, delay: Math.min(i, 8) * 0.04, ease: EASE }}>
      <a className="vault-card" href={`#/card/${c.token_id}`}>
        <Tilt foil={rarity} max={11} className={`vault-card__art vault-card__art--${rarity}`}>
          {c.thumb ? <img src={c.thumb} alt="" loading="lazy" onLoad={(e) => e.currentTarget.classList.add("is-loaded")} /> : <span className="vault-card__sealed"><Package size={26} aria-hidden="true" /></span>}
        </Tilt>
        <span className="vault-card__meta">
          <strong title={c.name ?? undefined}>{c.name ?? "Sealed pack"}</strong>
          <span className="vault-card__row">
            <span className={`dot dot--${rarity}`} aria-hidden="true" />
            <span className="tabular">{money(insured(c))}</span>
            <span className="hint">{statusLabel(c)}</span>
          </span>
          {expires && isHeld(c) && <span className="vault-card__offer"><Timer size={12} aria-hidden="true" /> Sell back {money(units(c.offer!.amountUnits))} · {expires}</span>}
          {units(c.proceedsUnits) > 0 && <span className="vault-card__offer vault-card__offer--money"><WalletIcon size={12} aria-hidden="true" /> {money(units(c.proceedsUnits))} to withdraw</span>}
        </span>
      </a>
    </motion.li>
  );
}

function RarityMix({ cards }: { cards: Card[] }) {
  const counts = RARITIES.map((r) => [r, cards.filter((c) => rarityOf(c.record.rarity) === r).length] as const);
  return (
    <div className="mix">
      {counts.map(([r, n]) => (
        <div className="mix__row" key={r}>
          <span className={`dot dot--${r}`} aria-hidden="true" />
          <span className="mix__name">{r}</span>
          <span className="mix__bar"><motion.i className={`seg--${r}`} initial={{ width: 0 }} animate={{ width: `${cards.length ? (n / cards.length) * 100 : 0}%` }} transition={{ duration: 0.9, ease: EASE }} /></span>
          <span className="tabular">{n}</span>
        </div>
      ))}
    </div>
  );
}

function Active({ orders, health, onPaid }: { orders: ActiveOrder[]; health: Health; onPaid: () => void }) {
  if (!orders.length) return null;
  return (
    <Reveal className="panel active">
      <h2><Clock size={17} aria-hidden="true" /> In progress</h2>
      <ul>
        {orders.map((o) => (
          <li key={o.orderId}>
            <span className={`pulse ${o.state === "needs_attention" ? "pulse--warn" : ""}`} aria-hidden="true" />
            <div className="active__body">
              <strong>{usd(units(o.priceUnits))} pack</strong>
              <span className="hint">{ORDER_LABEL[o.state] ?? o.state} · started {timeAgo(o.createdAt)}</span>
            </div>
            {o.state === "needs_attention" && <button className="btn btn--small" onClick={() => api.retryOrder(o.orderId).then(onPaid, onPaid)}>Try again now</button>}
            {o.state === "awaiting_payment" && o.status === "PENDING_DEPOSIT" && health.testPay && (
              <button className="btn btn--small" onClick={() => api.testPay(o.orderId).then(onPaid, () => undefined)}>Pay with test USDC</button>
            )}
            {o.state === "awaiting_payment" && o.status === "PENDING_DEPOSIT" && !health.testPay && <CopyButton text={o.orderId} label="Copy deposit address" />}
          </li>
        ))}
      </ul>
    </Reveal>
  );
}

const ACTIVITY: Record<string, { icon: React.ReactNode; title: (a: ActivityItem) => string }> = {
  order: { icon: <PackageOpen size={16} aria-hidden="true" />, title: (a) => (a.name ? `Opened ${a.name}` : `Bought a ${usd(units(a.packPriceUnits ?? 0))} pack`) },
  sellback: { icon: <WalletIcon size={16} aria-hidden="true" />, title: (a) => `${a.byKeeper ? "Your Keeper sold back" : "Sold back"} for ${usd(units(String(a.detail?.price ?? 0)))}` },
  withdraw_card: { icon: <Truck size={16} aria-hidden="true" />, title: () => "Withdrew a card to a wallet" },
  withdraw_proceeds: { icon: <ArrowLeftRight size={16} aria-hidden="true" />, title: (a) => `Withdrew ${usd(units(String(a.detail?.amount ?? 0)))} USDC` },
  cash_out: { icon: <ArrowLeftRight size={16} aria-hidden="true" />, title: (a) => `Cashed out ${usd(units(String(a.detail?.amount ?? 0)))} to ${a.detail?.symbol} on ${chainLabel({ chain: String(a.detail?.chain ?? "") })}${a.swapStatus === "REFUNDED" || a.swapStatus === "FAILED" ? " (refunded)" : a.swapStatus === "SUCCESS" ? "" : " (swapping)"}` },
};

function Activity({ items, health }: { items: ActivityItem[]; health: Health }) {
  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <h2 id="activity-title">Activity</h2>
      {items.length === 0 && <p className="hint">Nothing yet. Your packs, sell-backs and withdrawals will show here.</p>}
      <ol>
        {items.map((a, i) => {
          const def = ACTIVITY[a.kind];
          if (!def) return null;
          return (
            <motion.li key={`${a.kind}-${a.at}-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.4, ease: EASE }}>
              <span className="activity__icon">{def.icon}</span>
              <div className="activity__body">
                {a.tokenId ? <a href={`#/card/${a.tokenId}`}>{def.title(a)}</a> : <span>{def.title(a)}</span>}
                <small>{timeAgo(a.at)}{a.kind === "order" && !["complete"].includes(a.state) ? ` · ${a.state === "refunded" ? "refunded" : a.state === "payment_failed" ? "not completed" : "in progress"}` : ""}</small>
              </div>
              {a.tx && <a className="icon-btn" href={solanaTx(a.tx, health.network)} target="_blank" rel="noreferrer" aria-label="View transaction"><ExternalLink size={14} aria-hidden="true" /></a>}
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}

export function Dashboard({ health, wallet, onSignIn }: { health: Health; wallet: Wallet | null; onSignIn: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");

  const load = useCallback(() => {
    if (!wallet) return Promise.resolve();
    return api.dashboard(wallet.accountId).then((d) => {
      setData(d);
      setError(null);
    }, (e) => setError(e.message));
  }, [wallet]);

  const hasActive = (data?.active.length ?? 0) > 0;
  useEffect(() => {
    void load();
    const t = setInterval(load, hasActive ? 5000 : 30000);
    return () => clearInterval(t);
  }, [load, hasActive]);

  const cards = data?.cards ?? [];
  const held = useMemo(() => cards.filter(isHeld), [cards]);
  const cardValue = held.reduce((n, c) => n + insured(c), 0);
  const claimable = cards.reduce((n, c) => n + units(c.proceedsUnits), 0);
  const offers = held.filter((c) => c.offer?.expiresAt).sort((a, b) => new Date(a.offer!.expiresAt!).getTime() - new Date(b.offer!.expiresAt!).getTime());
  const soonest = offers[0];
  const offerTotal = offers.reduce((n, c) => n + units(c.offer!.amountUnits), 0);

  const shown = useMemo(() => {
    const f = cards.filter((c) => (filter === "all" ? true : filter === "held" ? isHeld(c) : filter === "sold" ? c.record.release_reason === "bought_back" : c.record.status === "Released" && c.record.release_reason !== "bought_back"));
    return [...f].sort((a, b) => (sort === "value" ? insured(b) - insured(a) : Number(b.token_id) - Number(a.token_id)));
  }, [cards, filter, sort]);

  if (!wallet) {
    return (
      <main className="page">
        <div className="empty empty--center">
          <h1 className="display">Your vault lives here</h1>
          <p className="lede">Sign in to see your cards, what they're worth, and what you can do with them.</p>
          <button className="btn btn--primary" onClick={onSignIn}>Sign in</button>
        </div>
      </main>
    );
  }

  return (
    <main className="page page--wide">
      <header className="dash-head">
        <div>
          <p className="kicker">Dashboard</p>
          <h1 className="display">Your vault</h1>
        </div>
        <div className="dash-head__acct">
          <span className="hint">NEAR account</span>
          <code title={wallet.accountId}>{short(wallet.accountId, 8)}</code>
          <CopyButton text={wallet.accountId} label="Copy account" />
        </div>
      </header>

      {error && <p className="error" role="alert">We couldn't refresh your vault. Showing the last known data. {error}</p>}

      <div className="stats">
        <Reveal className="stat stat--hero">
          <p className="stat__label">Vault value</p>
          {data ? <p className="stat__big"><CountUp value={cardValue + claimable} format={money} /></p> : <Skeleton style={{ height: 66, width: 220, display: "block" }} />}
          <p className="hint">{held.length > 0 ? `${held.length} card${held.length === 1 ? "" : "s"} at Collector Crypt's insured value, plus any USDC to withdraw. Insured value isn't a market price.` : "No cards held right now. This is your USDC to withdraw."}</p>
          <div className="stat__glow" aria-hidden="true" />
        </Reveal>
        <Reveal className="stat" delay={0.06}>
          <p className="stat__label"><WalletIcon size={15} aria-hidden="true" /> USDC to withdraw</p>
          {data ? <p className="stat__num"><CountUp value={claimable} format={money} /></p> : <Skeleton style={{ height: 40, width: 110, display: "block" }} />}
          <p className="hint">{claimable > 0 ? "Held by your NFTs. Open a sold card to withdraw." : "Sell a card back and it lands here."}</p>
        </Reveal>
        <Reveal className="stat" delay={0.12}>
          <p className="stat__label"><Timer size={15} aria-hidden="true" /> Sell-back offers</p>
          {data ? <p className="stat__num"><CountUp value={offerTotal} format={money} /></p> : <Skeleton style={{ height: 40, width: 110, display: "block" }} />}
          <p className="hint">{soonest ? <>Next one ends in <strong>{timeLeft(soonest.offer!.expiresAt)}</strong></> : "No live offers."}</p>
        </Reveal>
        <Reveal className="stat" delay={0.18}>
          <p className="stat__label"><PackageOpen size={15} aria-hidden="true" /> By rarity</p>
          {data ? <RarityMix cards={cards} /> : <Skeleton style={{ height: 96, display: "block" }} />}
        </Reveal>
      </div>

      {data && <Active orders={data.active} health={health} onPaid={load} />}

      <div className="dash-grid">
        <section aria-labelledby="cards-title">
          <div className="dash-toolbar">
            <h2 id="cards-title">Cards <span className="count tabular">{cards.length}</span></h2>
            <div className="tabs" role="group" aria-label="Filter cards">
              {FILTERS.map(([k, label]) => (
                <button key={k} className={filter === k ? "tab is-on" : "tab"} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {filter === k && <motion.span layoutId="tab-pill" className="tab__pill" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <label className="sort">
              <span className="sr-only">Sort cards</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="newest">Newest</option>
                <option value="value">Highest value</option>
              </select>
            </label>
          </div>

          {!data && <ul className="vault-grid">{[0, 1, 2, 3, 4, 5].map((i) => <li key={i}><Skeleton style={{ aspectRatio: "5 / 8", display: "block", borderRadius: 14 }} /></li>)}</ul>}
          {data && cards.length === 0 && (
            <motion.div className="empty panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
              <h3 className="display display--sm">No cards yet</h3>
              <p className="lede">Your first pack is a moment away.</p>
              <a className="btn btn--primary" href="#/" onClick={() => setTimeout(() => document.getElementById("packs")?.scrollIntoView({ behavior: "smooth" }), 150)}>Open your first pack <ArrowRight size={16} aria-hidden="true" /></a>
            </motion.div>
          )}
          {data && cards.length > 0 && shown.length === 0 && <p className="hint">Nothing here yet.</p>}
          <ul className="vault-grid">
            <AnimatePresence mode="popLayout">
              {shown.map((c, i) => <Tile key={c.token_id} c={c} i={i} />)}
            </AnimatePresence>
          </ul>
        </section>

        <aside>{data ? <Activity items={data.activity} health={health} /> : <Skeleton style={{ height: 320, display: "block", borderRadius: 20 }} />}</aside>
      </div>
    </main>
  );
}
