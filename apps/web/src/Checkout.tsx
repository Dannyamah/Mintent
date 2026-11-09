// Pay for one pack from any supported asset, then watch it become a card.
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { api, short, timeLeft, units, usd, type Health, type Order, type OrderCreated, type Pack, type PayAsset } from "./api";
import { CopyButton, EASE, Sheet, useNow } from "./ui";
import type { Wallet } from "./wallet";

const STEPS: { state: string; label: string; note: string }[] = [
  { state: "awaiting_payment", label: "Payment", note: "Waiting for your deposit, then proving it arrived on Solana." },
  { state: "paid", label: "Your NFT", note: "Minting your sealed pack on NEAR." },
  { state: "minted", label: "Buying the pack", note: "NEAR's signing network signs the purchase. Usually 15 seconds, sometimes a minute." },
  { state: "purchased", label: "The draw", note: "Collector Crypt's verifiable draw is picking your card." },
  { state: "complete", label: "Ready", note: "Your card is held by your NFT's own address." },
];

const CHAINS: Record<string, string> = { btc: "Bitcoin", sol: "Solana", eth: "Ethereum", base: "Base", arb: "Arbitrum", near: "NEAR", doge: "Dogecoin", xrp: "XRP", ltc: "Litecoin", zec: "Zcash", sui: "Sui", aptos: "Aptos", cardano: "Cardano", bch: "Bitcoin Cash", dash: "Dash", starknet: "Starknet", gnosis: "Gnosis", bera: "Berachain", scroll: "Scroll", plasma: "Plasma", hood: "Robinhood Chain", abs: "Abstract", aleo: "Aleo" };
const chainLabel = (a: PayAsset) => CHAINS[a.chain] ?? a.chain;
const RANK = ["SOL", "USDC", "ETH", "BTC", "USDT", "NEAR"];

function Qr({ text }: { text: string }) {
  const { data, size } = useMemo(() => encode(text, { border: 1 }), [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of the deposit address" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      {data.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#07080a" /> : null)))}
    </svg>
  );
}

function AssetPicker({ assets, value, onChange }: { assets: PayAsset[]; value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState("");
  const list = assets.filter((a) => `${a.symbol} ${chainLabel(a)}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <fieldset className="assets">
      <legend>Pay with</legend>
      {assets.length > 8 && (
        <label className="assets__search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search assets</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search coin or chain" autoComplete="off" />
        </label>
      )}
      <div className="assets__grid">
        {assets.length === 0 && <span className="hint">Loading assets…</span>}
        {list.map((a) => (
          <button type="button" key={a.assetId} className={`asset ${a.assetId === value ? "is-on" : ""}`} aria-pressed={a.assetId === value} onClick={() => onChange(a.assetId)}>
            <strong>{a.symbol}</strong>
            <small>{chainLabel(a)}</small>
          </button>
        ))}
        {assets.length > 0 && list.length === 0 && <span className="hint">No match.</span>}
      </div>
    </fieldset>
  );
}

function Stepper({ index }: { index: number }) {
  return (
    <ol className="stepper" aria-live="polite">
      {STEPS.map((s, i) => (
        <li key={s.state} className={i < index ? "is-done" : i === index ? "is-now" : ""}>
          <span className="stepper__dot" aria-hidden="true">
            {i < index ? <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}><Check size={13} strokeWidth={3} /></motion.span> : null}
          </span>
          <div>
            <strong>{s.label}</strong>
            <AnimatePresence initial={false}>
              {i === index && (
                <motion.p className="hint" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }}>
                  {s.note}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Checkout({ pack, health, wallet, onClose, onDone }: { pack: Pack; health: Health; wallet: Wallet; onClose: () => void; onDone: (tokenId: string) => void }) {
  const [assets, setAssets] = useState<PayAsset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [adult, setAdult] = useState(false);
  const [created, setCreated] = useState<OrderCreated | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const isTest = health.network === "testnet";
  const asset = assets.find((a) => a.assetId === assetId);

  useEffect(() => {
    api.payAssets().then((list) => {
      const score = (a: PayAsset) => (RANK.indexOf(a.symbol) + 1 || 99) * 10 + (a.chain === "sol" ? 0 : 1);
      const sorted = [...list].sort((a, b) => score(a) - score(b));
      setAssets(sorted);
      setAssetId(sorted[0]?.assetId ?? "");
    }, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!created) return;
    let live = true;
    const poll = async () => {
      try {
        const o = await api.order(created.orderId);
        if (!live) return;
        setOrder(o);
        if (o.state === "complete" && o.token_id) setTimeout(() => onDone(o.token_id!), 1000);
      } catch {
        /* keep polling through a network hiccup */
      }
    };
    void poll();
    const t = setInterval(poll, 2500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [created, onDone]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(
        await api.createOrder(
          isTest
            ? { buyer: wallet.accountId, packType: pack.code, originAsset: assetId, refundTo: wallet.accountId, depositType: "INTENTS", refundType: "INTENTS" }
            : { buyer: wallet.accountId, packType: pack.code, originAsset: assetId, refundTo: refundTo.trim() },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [assetId, isTest, pack.code, refundTo, wallet.accountId]);

  const testPay = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.testPay(created!.orderId);
      setPaid(true);
    } catch (e) {
      setError("The test payment didn't go through. Try again in a moment.");
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const fee = (pack.price * health.serviceFeeBps) / 10_000;
  const state = order?.state ?? "awaiting_payment";
  const stepIndex = Math.max(STEPS.findIndex((s) => s.state === state), 0);
  const failed = ["refunded", "payment_failed", "needs_attention"].includes(state);
  const waitingDeposit = created && state === "awaiting_payment" && !paid && (order?.checkout_status ?? "PENDING_DEPOSIT") === "PENDING_DEPOSIT";
  const remaining = created ? timeLeft(created.deadline) : null;
  void now;

  return (
    <Sheet onClose={onClose} labelledBy="checkout-title">
      <header className="sheet__head">
        <h2 id="checkout-title">{pack.name}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        {!created ? (
          <motion.div key="details" className="stack" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.25, ease: EASE }}>
            <AssetPicker assets={assets} value={assetId} onChange={setAssetId} />
            {asset?.symbol === "BTC" && <p className="note"><AlertTriangle size={15} aria-hidden="true" /> Bitcoin takes about 13 minutes to settle. Other coins take under a minute.</p>}

            {!isTest && (
              <div className="field">
                <label htmlFor="refund">Your {asset ? chainLabel(asset) : ""} address, for refunds</label>
                <input id="refund" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} autoComplete="off" spellCheck={false} />
                <p className="hint">If the payment can't complete, it goes back here.</p>
              </div>
            )}

            <dl className="sum">
              <div><dt>Pack</dt><dd>{usd(pack.price)}</dd></div>
              <div><dt>Mintent fee ({health.serviceFeeBps / 100}%)</dt><dd>{usd(fee)}</dd></div>
              <div className="sum__total"><dt>You pay about</dt><dd>{usd(pack.price + fee)} <small>+ network costs</small></dd></div>
            </dl>

            <div className="odds">
              <h3>What's in the pack</h3>
              <ul>
                {["common", "uncommon", "rare", "epic"].map((k) => (
                  <li key={k}>
                    <span className={`dot dot--${k}`} aria-hidden="true" />
                    <span>{k}</span>
                    <span className="odds__bar"><motion.i className={`seg--${k}`} initial={{ width: 0 }} animate={{ width: `${Math.max((pack.odds[k] ?? 0) * 100, 1.5)}%` }} transition={{ duration: 0.8, ease: EASE }} /></span>
                    <span className="tabular">{((pack.odds[k] ?? 0) * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
              <p className="hint">
                One real graded card{pack.expectedValue ? `, average insured value ${usd(Math.round(pack.expectedValue * 100) / 100)}` : ""}. Most pulls are common and may be worth less than you paid. Collector Crypt offers an instant sell-back for a limited time at about {pack.buybackPct}% of insured value, and your card page shows the exact deadline.
              </p>
            </div>

            <label className="check">
              <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
              <span>I'm 18 or over, and I understand this is a random pack.</span>
            </label>

            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn btn--primary btn--full" disabled={!adult || !assetId || busy || (!isTest && !refundTo.trim())} onClick={start}>
              {busy ? <><span className="spinner" aria-hidden="true" /> Getting your quote…</> : "Get payment details"}
            </button>
          </motion.div>
        ) : (
          <motion.div key="paying" className="stack" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease: EASE }}>
            <AnimatePresence>
              {waitingDeposit && (
                <motion.div className="pay" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3 }}>
                  <p className="pay__amount">
                    Send exactly
                    <strong>{created.amountInFormatted ?? units(created.amountIn)} {asset?.symbol}</strong>
                    <small>on {asset ? chainLabel(asset) : ""}{remaining ? ` · quote valid for ${remaining}` : ""}</small>
                  </p>
                  {isTest && health.testPay ? (
                    <>
                      <p className="hint">Test network: no real money moves.</p>
                      <button className="btn btn--primary btn--full" disabled={busy} onClick={testPay}>
                        {busy ? <><span className="spinner" aria-hidden="true" /> Sending…</> : "Pay with test USDC"}
                      </button>
                    </>
                  ) : (
                    <div className="pay__qr">
                      <Qr text={created.depositAddress} />
                      <div className="pay__addr">
                        <code title={created.depositAddress}>{created.depositAddress}</code>
                        <CopyButton text={created.depositAddress} label="Copy address" />
                      </div>
                      {created.depositMemo && (
                        <div className="pay__addr">
                          <code>Memo: {created.depositMemo}</code>
                          <CopyButton text={created.depositMemo} label="Copy memo" />
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {!failed && <Stepper index={stepIndex} />}
            {state === "refunded" && <p className="error" role="alert">Your payment was refunded, and no pack was bought.</p>}
            {state === "payment_failed" && <p className="error" role="alert">The payment didn't complete, so no pack was bought.</p>}
            {state === "needs_attention" && <p className="error" role="alert">Your payment arrived, but we couldn't finish the order. It's saved and nothing is lost. Reference: <code>{short(created.orderId)}</code></p>}
            {error && <p className="error" role="alert">{error}</p>}
            <p className="hint">You can close this. Your order keeps going, and you can follow it on your dashboard.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}
