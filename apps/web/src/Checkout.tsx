// Pay for one pack from any supported asset, then watch it become a card.
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { api, short, timeLeft, units, usd, type Health, type Order, type OrderCreated, type Pack, type PayAsset } from "./api";
import { CopyButton, EASE, Sheet, useNow } from "./ui";
import type { LoginWallet, WalletPayment } from "./privy";
import type { Wallet } from "./wallet";

const STEPS: { state: string; label: string; note: string }[] = [
  { state: "awaiting_payment", label: "Payment", note: "Waiting for your deposit, then proving it arrived on Solana." },
  { state: "paid", label: "Your NFT", note: "Minting your sealed pack on NEAR." },
  { state: "minted", label: "Buying the pack", note: "NEAR's signing network signs the purchase. Usually 15 seconds, sometimes a minute." },
  { state: "purchased", label: "The draw", note: "Collector Crypt's verifiable draw is picking your card." },
  { state: "complete", label: "Ready", note: "Your card is held by your NFT's own address." },
];

const CHAINS: Record<string, string> = { btc: "Bitcoin", sol: "Solana", eth: "Ethereum", base: "Base", arb: "Arbitrum", near: "NEAR", doge: "Dogecoin", xrp: "XRP", ltc: "Litecoin", zec: "Zcash", sui: "Sui", aptos: "Aptos", cardano: "Cardano", bch: "Bitcoin Cash", dash: "Dash", starknet: "Starknet", gnosis: "Gnosis", bera: "Berachain", scroll: "Scroll", plasma: "Plasma", hood: "Robinhood Chain", abs: "Abstract", aleo: "Aleo" };
export const chainLabel = (a: { chain: string }) => CHAINS[a.chain] ?? a.chain;
const RANK = ["SOL", "USDC", "ETH", "BTC", "USDT", "NEAR"];
export const rankAssets = (list: PayAsset[]) => {
  const score = (a: PayAsset) => (RANK.indexOf(a.symbol) + 1 || 99) * 10 + (a.chain === "sol" ? 0 : 1);
  return [...list].sort((a, b) => score(a) - score(b));
};
const EVM = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "scroll", "plasma", "hood", "abs", "monad", "xlayer", "adi"]);
/** The signed-in wallet's address, if it can receive on this chain. */
export const addressFor = (chain: string | undefined, login: LoginWallet | null) => (!chain || !login ? "" : (login.chainType === "ethereum" && EVM.has(chain)) || (login.chainType === "solana" && chain === "sol") ? login.address : "");

function Qr({ text }: { text: string }) {
  const { data, size } = useMemo(() => encode(text, { border: 1 }), [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of the deposit address" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      {data.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#07080a" /> : null)))}
    </svg>
  );
}

export function AssetPicker({ assets, value, onChange, legend = "Pay with" }: { assets: PayAsset[]; value: string; onChange: (id: string) => void; legend?: string }) {
  const [q, setQ] = useState("");
  const list = assets.filter((a) => `${a.symbol} ${chainLabel(a)}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <fieldset className="assets">
      <legend>{legend}</legend>
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

// Chains a connected Ethereum wallet can pay from in one click. Testnet uses the Sepolia networks Tidepool bridges.
const EVM_CHAIN_IDS: Record<Health["network"], Record<string, number>> = {
  mainnet: { eth: 1, base: 8453, arb: 42161 },
  testnet: { eth: 11155111, base: 84532, arb: 421614 },
};

export function Checkout({ pack, health, wallet, loginWallet, payFromWallet, onClose, onDone }: { pack: Pack; health: Health; wallet: Wallet; loginWallet: LoginWallet | null; payFromWallet?: (p: WalletPayment) => Promise<string>; onClose: () => void; onDone: (tokenId: string) => void }) {
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
  const asset = assets.find((a) => a.assetId === assetId);
  // The one asset the test funder can pay with, from inside the test network. Everything else uses a real deposit address.
  const isTestPay = Boolean(health.testPayAsset) && assetId === health.testPayAsset;

  useEffect(() => {
    api.payAssets().then((list) => {
      const sorted = rankAssets(list);
      setAssets(sorted);
      setAssetId(sorted.find((a) => a.assetId === health.testPayAsset)?.assetId ?? sorted[0]?.assetId ?? "");
    }, (e) => setError(e.message));
  }, [health.testPayAsset]);

  // Refund to the wallet they signed in with, when it works on the chosen chain. They can still change it.
  useEffect(() => {
    setRefundTo(addressFor(asset?.chain, loginWallet));
  }, [asset?.chain, loginWallet]);

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
          isTestPay
            ? { buyer: wallet.accountId, packType: pack.code, originAsset: assetId, refundTo: wallet.accountId, depositType: "INTENTS", refundType: "INTENTS" }
            : { buyer: wallet.accountId, packType: pack.code, originAsset: assetId, refundTo: refundTo.trim() },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [assetId, isTestPay, pack.code, refundTo, wallet.accountId]);

  const testPay = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.testPay(created!.orderId);
      setPaid(true);
    } catch (e) {
      const why = e instanceof Error ? e.message : "";
      setError(/free test packs|already been paid/.test(why) ? why : "The test payment didn't go through. Try again in a moment.");
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const chainId = asset ? EVM_CHAIN_IDS[health.network][asset.chain] : undefined;
  const oneClick = payFromWallet && chainId && asset && (asset.contract || asset.symbol === "ETH") ? payFromWallet : undefined;
  const payNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const hash = await oneClick!({ chainId: chainId!, to: created!.depositAddress, token: asset!.contract ?? null, amount: BigInt(created!.amountIn) });
      setPaid(true);
      await api.submitDeposit(created!.orderId, hash).catch(() => undefined); // only speeds up detection
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(/reject|denied|cancel/i.test(why) ? "You cancelled the payment in your wallet. Nothing was sent." : "Your wallet couldn't send the payment. You can still pay by sending to the address below.");
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const fee = (pack.price * health.serviceFeeBps) / 10_000;
  const state = order?.state ?? "awaiting_payment";
  const stepIndex = Math.max(STEPS.findIndex((s) => s.state === state), 0);
  const failed = ["refunded", "payment_failed", "needs_attention"].includes(state);
  const status = order?.checkout_status ?? "PENDING_DEPOSIT";
  const underpaid = state === "awaiting_payment" && status === "INCOMPLETE_DEPOSIT";
  const waitingDeposit = created && state === "awaiting_payment" && !paid && (status === "PENDING_DEPOSIT" || underpaid);
  const remaining = created ? timeLeft(created.deadline) : null;
  const expired = Boolean(created) && !remaining && state === "awaiting_payment" && status === "PENDING_DEPOSIT";
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

            {!isTestPay && (
              <div className="field">
                <label htmlFor="refund">Your {asset ? chainLabel(asset) : ""} address, for refunds</label>
                <input id="refund" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} autoComplete="off" spellCheck={false} />
                <p className="hint">If the payment can't complete, it goes back here.{asset && addressFor(asset.chain, loginWallet) === refundTo && refundTo ? " This is the wallet you signed in with." : ""}</p>
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
            <button className="btn btn--primary btn--full" disabled={!adult || !assetId || busy || (!isTestPay && !refundTo.trim())} onClick={start}>
              {busy ? <><span className="spinner" aria-hidden="true" /> Getting your quote…</> : "Get payment details"}
            </button>
          </motion.div>
        ) : (
          <motion.div key="paying" className="stack" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease: EASE }}>
            <AnimatePresence>
              {waitingDeposit && (
                <motion.div className="pay" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3 }}>
                  {underpaid && <p className="note"><AlertTriangle size={15} aria-hidden="true" /> We've received less than the full amount. Send the rest to the same address before the quote ends, or it will be refunded.</p>}
                  {expired && <p className="error" role="alert">This quote has ended, so don't send anything. If you already sent money, it will be refunded to your address. Close this and start again for a new quote.</p>}
                  {!expired && <p className="pay__amount">
                    Send exactly
                    <strong>{created.amountInFormatted ?? units(created.amountIn)} {asset?.symbol}</strong>
                    <small>on {asset ? chainLabel(asset) : ""}{remaining ? ` · quote valid for ${remaining}` : ""}</small>
                  </p>}
                  {expired ? null : isTestPay ? (
                    <>
                      <p className="hint">Test network: no real money moves.</p>
                      <button className="btn btn--primary btn--full" disabled={busy} onClick={testPay}>
                        {busy ? <><span className="spinner" aria-hidden="true" /> Sending…</> : "Pay with test USDC"}
                      </button>
                    </>
                  ) : (
                    <>
                    {oneClick && (
                      <button className="btn btn--primary btn--full" disabled={busy} onClick={payNow}>
                        {busy ? <><span className="spinner" aria-hidden="true" /> Confirm in your wallet…</> : `Pay ${created.amountInFormatted ?? units(created.amountIn)} ${asset?.symbol} from your wallet`}
                      </button>
                    )}
                    {oneClick && <p className="hint pay__or">Or send it yourself:</p>}
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
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {!failed && <Stepper index={stepIndex} />}
            {state === "refunded" && <p className="error" role="alert">Your payment was refunded, and no pack was bought.</p>}
            {state === "payment_failed" && <p className="error" role="alert">The payment didn't complete, so no pack was bought.</p>}
            {state === "needs_attention" && (
              <div className="stack">
                <p className="error" role="alert">Your payment arrived, but your order is delayed. We keep retrying it automatically, and your payment is saved. Reference: <code>{short(created.orderId)}</code></p>
                <button className="btn btn--full" disabled={busy} onClick={() => {
                  setBusy(true);
                  setError(null);
                  api.retryOrder(created.orderId).catch((e) => setError(e.message)).finally(() => setBusy(false));
                }}>Try again now</button>
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <p className="hint">You can close this. Your order keeps going, and you can follow it on your dashboard.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}
