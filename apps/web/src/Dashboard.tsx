// Your vault: what you hold and what it's worth, what needs action, orders in flight, and everything that has happened.
// Every number is read live from NEAR, Solana and Collector Crypt. Nothing is estimated.
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowLeftRight, ArrowRight, Bot, Check, Clock, ExternalLink, Package, PackageOpen, Sparkles, Timer, Truck, Wallet as WalletIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, insured, rarityOf, short, solanaTx, statusLabel, timeAgo, timeLeft, units, usd, type ActiveOrder, type ActivityItem, type Card, type Dashboard as Data, type Health, type Rarity } from "./api";
import { CopyButton, CountUp, EASE, Reveal, Skeleton, Tilt } from "./ui";
import { chainLabel } from "./Checkout";
import type { Wallet } from "./wallet";
import { PackArt } from "./Home";
import { cardPath, openPath, wasOpened } from "./links";

const money = (n: number) => usd(Math.round(n * 100) / 100);
type Filter = "all" | "held" | "sold" | "out";
const FILTERS: [Filter, string][] = [["all", "All"], ["held", "Holding"], ["sold", "Sold back"], ["out", "Withdrawn"]];
type Sort = "newest" | "value";
const ORDER_LABEL: Record<string, string> = { awaiting_payment: "Waiting for your payment", paid: "Minting your NFT", minted: "Buying your pack", purchased: "Drawing your card", needs_attention: "Delayed. We keep retrying automatically" };
const DAY = 24 * 60 * 60 * 1000;
const ORDER_STEPS = ["Payment", "Your NFT", "Buying the pack", "The draw"];
const ORDER_STEP: Record<string, number> = { awaiting_payment: 0, paid: 1, minted: 2, purchased: 3 };

function isHeld(c: Card) {
  return c.record.status === "Opened" && c.heldByToken;
}

/** The pack's card has arrived but this browser hasn't torn it open yet: offer the reveal, and don't spoil it. */
function isFresh(c: Card, contractId: string) {
  return Boolean(c.record.card_mint) && c.record.status === "Opened" && c.mintedAt !== null && Date.now() - c.mintedAt < 3 * DAY && !wasOpened(contractId, c.token_id);
}

const keeperOn = (c: Card) => Boolean(c.keeper && Number(c.keeper.expires_ms) > Date.now());
const packPrice = (c: Card) => Number(c.record.pack_type.match(/\d+/)?.[0] ?? 0);

function Tile({ c, i, contractId }: { c: Card; i: number; contractId: string }) {
  const rarity = rarityOf(c.record.rarity);
  const expires = c.offer ? timeLeft(c.offer.expiresAt) : null;
  const sealed = !c.record.card_mint;
  const fresh = isFresh(c, contractId);
  const hidden = sealed || fresh;
  return (
    <motion.li layout initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.45, delay: Math.min(i, 8) * 0.04, ease: EASE }}>
      <a className={`vault-card ${fresh ? "vault-card--fresh" : ""}`} href={hidden ? openPath(c.links.code) : cardPath(c.links)}>
        <span className="vault-card__frame">
          <Tilt foil={hidden ? "pack" : rarity} max={11} className={`vault-card__art vault-card__art--${hidden ? "pack" : rarity}`}>
            {hidden ? <span className="vault-card__pack"><PackArt price={packPrice(c)} /></span>
              : c.thumb ? <img src={c.thumb} alt="" loading="lazy" onLoad={(e) => e.currentTarget.classList.add("is-loaded")} />
              : <span className="vault-card__sealed"><Package size={26} aria-hidden="true" /></span>}
          </Tilt>
          {fresh && <span className="vault-card__new"><Sparkles size={12} aria-hidden="true" /> New · tap to open</span>}
          {sealed && <span className="vault-card__new vault-card__new--wait"><span className="spinner" aria-hidden="true" /> On its way</span>}
          {!hidden && keeperOn(c) && <span className="vault-card__chip"><Bot size={12} aria-hidden="true" /> Keeper on</span>}
        </span>
        <span className="vault-card__meta">
          <strong title={hidden ? undefined : c.name ?? undefined}>{hidden ? `${usd(packPrice(c))} pack` : c.name ?? "Your card"}</strong>
          {!hidden && (
            <span className="vault-card__row">
              <span className={`dot dot--${rarity}`} aria-hidden="true" />
              <span className="tabular">{money(insured(c))}</span>
              <span className="hint">{statusLabel(c)}</span>
            </span>
          )}
          {hidden && <span className="hint">{fresh ? "Your card is inside" : "Buying your pack"}</span>}
          {!hidden && expires && isHeld(c) && <span className="vault-card__offer"><Timer size={12} aria-hidden="true" /> Sell back {money(units(c.offer!.amountUnits))} · {expires}</span>}
          {units(c.proceedsUnits) > 0 && <span className="vault-card__offer vault-card__offer--money"><WalletIcon size={12} aria-hidden="true" /> {money(units(c.proceedsUnits))} to cash out</span>}
        </span>
      </a>
    </motion.li>
  );
}

/** What's waiting for you: packs to open, offers about to end, and money to cash out. */
function ReadyStrip({ cards, contractId }: { cards: Card[]; contractId: string }) {
  const items: { key: string; icon: React.ReactNode; title: string; body: string; href: string; cta: string; tone?: string }[] = [];
  for (const c of cards.filter((x) => isFresh(x, contractId))) items.push({ key: `open-${c.token_id}`, icon: <Sparkles size={18} />, title: "A pack is ready to open", body: `Your ${usd(packPrice(c))} pack has arrived.`, href: openPath(c.links.code), cta: "Open it", tone: "fresh" });
  for (const c of cards.filter((x) => isHeld(x) && !isFresh(x, contractId) && x.offer?.expiresAt && new Date(x.offer.expiresAt).getTime() - Date.now() < 3 * DAY && !keeperOn(x))) {
    items.push({ key: `offer-${c.token_id}`, icon: <Timer size={18} />, title: `Offer ends in ${timeLeft(c.offer!.expiresAt)}`, body: `${money(units(c.offer!.amountUnits))} for ${c.name ?? "your card"}.`, href: cardPath(c.links), cta: "Decide", tone: "warn" });
  }
  for (const c of cards.filter((x) => units(x.proceedsUnits) > 0 && !keeperOn(x))) items.push({ key: `cash-${c.token_id}`, icon: <WalletIcon size={18} />, title: `${money(units(c.proceedsUnits))} to cash out`, body: `From ${c.name ?? "a sold card"}, as any coin on any chain.`, href: cardPath(c.links), cta: "Cash out" });
  if (!items.length) return null;
  return (
    <section className="ready" aria-labelledby="ready-title">
      <h2 id="ready-title" className="ready__title">Ready for you <span className="count tabular">{items.length}</span></h2>
      <ul className="ready__list">
        {items.slice(0, 6).map((it, i) => (
          <motion.li key={it.key} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.4, ease: EASE }}>
            <a className={`ready__item ${it.tone ? `ready__item--${it.tone}` : ""}`} href={it.href}>
              <span className="ready__icon" aria-hidden="true">{it.icon}</span>
              <span className="ready__text"><strong>{it.title}</strong><span>{it.body}</span></span>
              <span className="ready__cta">{it.cta} <ArrowRight size={14} aria-hidden="true" /></span>
            </a>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}


function Active({ orders, health, onPaid }: { orders: ActiveOrder[]; health: Health; onPaid: () => void }) {
  if (!orders.length) return null;
  return (
    <Reveal className="panel active">
      <h2><Clock size={17} aria-hidden="true" /> On the way</h2>
      <p className="hint">Each order finishes on its own, even if you close the page.</p>
      <ul>
        {orders.map((o) => {
          const step = ORDER_STEP[o.state] ?? 0;
          const stuck = o.state === "needs_attention";
          const body = (
            <>
              <div className="active__top">
                <span className={`pulse ${stuck ? "pulse--warn" : ""}`} aria-hidden="true" />
                <div className="active__body">
                  <strong>{usd(units(o.priceUnits))} pack</strong>
                  <span className="hint">{ORDER_LABEL[o.state] ?? o.state} · started {timeAgo(o.createdAt)}</span>
                </div>
                {o.code && <span className="active__go">Watch it open <ArrowRight size={14} aria-hidden="true" /></span>}
              </div>
              <ol className="active__steps" aria-label="Progress">
                {ORDER_STEPS.map((label, i) => (
                  <li key={label} className={stuck ? (i === 0 ? "is-done" : "") : i < step ? "is-done" : i === step ? "is-now" : ""}>
                    <span aria-hidden="true">{i < step ? <Check size={11} /> : null}</span>{label}
                  </li>
                ))}
              </ol>
              {stuck && <p className="active__warn"><AlertTriangle size={14} aria-hidden="true" /> Delayed. It keeps retrying by itself.</p>}
            </>
          );
          return (
            <li key={o.orderId} className="active__item">
              {o.code ? <a className="active__link" href={openPath(o.code)}>{body}</a> : <div className="active__link">{body}</div>}
              <div className="active__actions">
                {stuck && <button className="btn btn--small" onClick={() => api.retryOrder(o.orderId).then(onPaid, onPaid)}>Try again now</button>}
                {o.state === "awaiting_payment" && o.status === "PENDING_DEPOSIT" && health.testPay && (
                  <button className="btn btn--small" onClick={() => api.testPay(o.orderId).then(onPaid, () => undefined)}>Pay with test USDC</button>
                )}
                {o.state === "awaiting_payment" && o.status === "PENDING_DEPOSIT" && !health.testPay && <CopyButton text={o.orderId} label="Copy deposit address" />}
              </div>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}

const ACTIVITY: Record<string, { icon: React.ReactNode; title: (a: ActivityItem) => string }> = {
  order: { icon: <PackageOpen size={16} aria-hidden="true" />, title: (a) => (a.name ? `Opened ${a.name}` : `Bought a ${usd(units(a.packPriceUnits ?? 0))} pack`) },
  sellback: { icon: <WalletIcon size={16} aria-hidden="true" />, title: (a) => `${a.byKeeper ? "Your Keeper sold back" : "Sold back"} for ${usd(units(String(a.detail?.price ?? 0)))}` },
  withdraw_card: { icon: <Truck size={16} aria-hidden="true" />, title: () => "Withdrew a card to a wallet" },
  withdraw_proceeds: { icon: <ArrowLeftRight size={16} aria-hidden="true" />, title: (a) => a.byKeeper ? `Your Keeper sent you ${usd(units(String(a.detail?.net ?? a.detail?.amount ?? 0)))} USDC` : `Withdrew ${usd(units(String(a.detail?.amount ?? 0)))} USDC` },
  cash_out: { icon: <ArrowLeftRight size={16} aria-hidden="true" />, title: (a) => `Cashed out ${usd(units(String(a.detail?.amount ?? 0)))} to ${a.detail?.symbol} on ${chainLabel({ chain: String(a.detail?.chain ?? "") })}${a.swapStatus === "REFUNDED" || a.swapStatus === "FAILED" ? " (refunded)" : a.swapStatus === "SUCCESS" ? "" : " (swapping)"}` },
};

function Activity({ items, health, unopened }: { items: ActivityItem[]; health: Health; unopened: Set<string> }) {
  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <h2 id="activity-title">Activity</h2>
      {items.length === 0 && <p className="hint">Nothing yet. Your packs, sell-backs and withdrawals will show here.</p>}
      <ol>
        {items.map((a, i) => {
          const def = ACTIVITY[a.kind];
          if (!def) return null;
          // Don't name a card before its pack has been torn open.
          const sealed = a.tokenId !== null && unopened.has(a.tokenId);
          const title = sealed ? `Bought a ${usd(units(a.packPriceUnits ?? 0))} pack · ready to open` : def.title(a);
          return (
            <motion.li key={`${a.kind}-${a.at}-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.4, ease: EASE }}>
              <span className="activity__icon">{def.icon}</span>
              <div className="activity__body">
                {a.code ? <a href={sealed ? openPath(a.code) : `/cards/${a.code}`}>{title}</a> : <span>{title}</span>}
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
  const watched = held.filter(keeperOn);

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
          <p className="stat__label"><Bot size={15} aria-hidden="true" /> Keeper</p>
          {data ? <p className="stat__num">{watched.length ? `${watched.length} on` : "Off"}</p> : <Skeleton style={{ height: 40, width: 110, display: "block" }} />}
          <p className="hint">{watched.length ? `Watching ${watched.length === 1 ? watched[0].name ?? "1 card" : `${watched.length} cards`} for you.` : "Open a card to let the Keeper sell it for you."}</p>
        </Reveal>
      </div>

      {data && <ReadyStrip cards={cards} contractId={health.contract} />}
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
          {data && cards.length === 0 && data.active.length > 0 && <p className="hint">Your first card is on its way. It will appear here, sealed, ready to open.</p>}
          {data && cards.length === 0 && data.active.length === 0 && (
            <motion.div className="empty panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
              <h3 className="display display--sm">No cards yet</h3>
              <p className="lede">Your first pack is a moment away.</p>
              <a className="btn btn--primary" href="/#packs">Open your first pack <ArrowRight size={16} aria-hidden="true" /></a>
            </motion.div>
          )}
          {data && cards.length > 0 && shown.length === 0 && <p className="hint">Nothing here yet.</p>}
          <ul className="vault-grid">
            <AnimatePresence mode="popLayout">
              {shown.map((c, i) => <Tile key={c.token_id} c={c} i={i} contractId={health.contract} />)}
            </AnimatePresence>
          </ul>
        </section>

        <aside>{data ? <Activity items={data.activity} health={health} unopened={new Set(cards.filter((c) => !c.record.card_mint || isFresh(c, health.contract)).map((c) => c.token_id))} /> : <Skeleton style={{ height: 320, display: "block", borderRadius: 20 }} />}</aside>
      </div>
    </main>
  );
}
