// A card: what it is, where it really is, the proof, and what its owner can do with it.
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowLeftRight, Check, ExternalLink, Lock, ShieldCheck, Truck, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { addressFor, AssetPicker, chainLabel, rankAssets } from "./Checkout";
import type { LoginWallet } from "./privy";
import { api, insured, nearAcct, rarityOf, short, solanaAddr, solanaTx, statusLabel, timeLeft, units, usd, type Card, type Health, type Op, type PayAsset } from "./api";
import { CopyButton, EASE, RarityBadge, Skeleton, Tilt, useNow, useToast } from "./ui";
import { sellbackPrice } from "./verifyMessage";
import { refusal, type SigningIntent, type Wallet as WalletT } from "./wallet";

type Action = "sellback" | "withdrawCard" | "cashOut" | "transfer";
const DIRECT = "direct"; // USDC on Solana is already what the NFT holds, so it needs no swap.

interface CashOutDetail { symbol: string; chain: string; decimals: number; recipient: string; amountOut: string; amountOutFormatted?: string; minAmountOut?: string; timeEstimateSeconds?: number }
const coin = (units: string | null | undefined, d: CashOutDetail) => (Number(units ?? 0) / 10 ** d.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 });

/** Follows a cash-out from "sent" to "delivered" or "refunded". */
function CashOutProgress({ opId, isTest, onDone }: { opId: string; isTest: boolean; onDone: () => void }) {
  const [op, setOp] = useState<Op | null>(null);
  useEffect(() => {
    let live = true;
    const poll = () => api.op(opId).then((o) => live && setOp(o), () => undefined);
    void poll();
    const t = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [opId]);
  const status = op?.swap_status ?? "PENDING_DEPOSIT";
  const finished = ["SUCCESS", "REFUNDED", "FAILED"].includes(status);
  useEffect(() => {
    if (finished) onDone();
  }, [finished, onDone]);
  if (!op) return null;
  const d = JSON.parse(op.detail) as CashOutDetail;
  if (status === "SUCCESS") return <p className="ok" role="status" data-cashout="delivered"><Check size={17} aria-hidden="true" /> <span>Delivered: {coin(op.swap_amount_out ?? d.amountOut, d)} {d.symbol} on {chainLabel(d)}, to {short(d.recipient, 8)}.</span></p>;
  if (finished) return <p className="error" role="alert" data-cashout="refunded">The swap didn't complete, so the money was refunded{isTest ? " to the test treasury" : " to this NFT's address, where you can cash it out again"}.</p>;
  return <div className="signing" role="status" data-cashout="swapping"><span className="spinner spinner--lg" aria-hidden="true" /><div><strong>Swapping to {d.symbol} on {chainLabel(d)}</strong><p className="hint">Your USDC has been sent to the swap. Usually under a minute, and you can leave this page.</p></div></div>;
}

function ProofRow({ i, ok, label, children, note }: { i: number; ok: boolean; label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <motion.li initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.1, duration: 0.45, ease: EASE }}>
      <span className={ok ? "proof__icon proof__icon--ok" : "proof__icon"} aria-hidden="true">{ok ? <Check size={13} strokeWidth={3} /> : <ArrowLeftRight size={12} />}</span>
      <div>
        <p className="proof__label">{label}</p>
        <div className="proof__value">{children}</div>
        {note && <p className="hint">{note}</p>}
      </div>
    </motion.li>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="ext">{children} <ExternalLink size={13} aria-hidden="true" /></a>;
}

function Proof({ card, health }: { card: Card; health: Health }) {
  const net = health.network;
  return (
    <section className="proof panel" aria-labelledby="proof-title">
      <h2 id="proof-title"><ShieldCheck size={19} aria-hidden="true" /> Check it yourself</h2>
      <ul>
        <ProofRow i={0} ok label="NFT owner on NEAR"><Ext href={nearAcct(card.owner_id, net)}>{short(card.owner_id, 10)}</Ext></ProofRow>
        <ProofRow i={1} ok label="The NFT's Solana address" note={<>Derived by NEAR's signing network ({card.mpcContract}) from contract {short(card.contractId, 10)} and path <code>{card.solana_path}</code>. Only the NFT's owner can make it sign.</>}>
          <Ext href={solanaAddr(card.solanaAddress, net)}>{short(card.solanaAddress)}</Ext>
          <CopyButton text={card.solanaAddress} label="Copy address" />
        </ProofRow>
        {card.record.card_mint && (
          <ProofRow i={2} ok={card.heldByToken} label="Who holds the card right now">
            <Ext href={solanaAddr(card.record.card_mint, net)}>{card.holder ? short(card.holder) : "Unknown"}</Ext>
            <span className={card.heldByToken ? "pill pill--ok" : "pill"}>{card.heldByToken ? "This NFT" : "Left this NFT"}</span>
          </ProofRow>
        )}
        {card.verifyUrl && <ProofRow i={3} ok label="Was the draw fair?"><Ext href={card.verifyUrl}>Collector Crypt's public verifier</Ext></ProofRow>}
      </ul>
      <div className="proof__cmd">
        <code>pnpm verify:pull {card.contractId} {card.token_id} {net}</code>
        <CopyButton text={`pnpm verify:pull ${card.contractId} ${card.token_id} ${net}`} label="Copy command" />
      </div>
      <p className="hint">Runs from public data only, and trusts nothing from Mintent.</p>
    </section>
  );
}

function SigningProgress({ text, since }: { text: string; since: number }) {
  const now = useNow();
  const s = Math.floor((now - since) / 1000);
  return (
    <motion.div className="signing" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <span className="spinner spinner--lg" aria-hidden="true" />
      <div>
        <strong>{text}</strong>
        <p className="hint">{s > 0 ? `${s}s. ` : ""}Usually about 15 seconds, and it can take a minute.</p>
      </div>
    </motion.div>
  );
}

const ACTIONS: { key: Action; icon: React.ReactNode; title: string; desc: string }[] = [
  { key: "sellback", icon: <Wallet size={20} aria-hidden="true" />, title: "Sell back for USDC", desc: "Instant, from Collector Crypt" },
  { key: "transfer", icon: <ArrowLeftRight size={20} aria-hidden="true" />, title: "Transfer this NFT", desc: "Control moves, the card doesn't" },
  { key: "withdrawCard", icon: <Truck size={20} aria-hidden="true" />, title: "Withdraw card to my wallet", desc: "To list it, or redeem the slab" },
];

export function CardPage({ tokenId, health, wallet, loginWallet }: { tokenId: string; health: Health; wallet: WalletT | null; loginWallet: LoginWallet | null }) {
  const [card, setCard] = useState<Card | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [destination, setDestination] = useState("");
  const [op, setOp] = useState<Op | null>(null);
  const [status, setStatus] = useState<{ text: string; since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; tx?: string } | null>(null);
  const [payouts, setPayouts] = useState<PayAsset[]>([]);
  const [payout, setPayout] = useState(DIRECT);
  const [swapping, setSwapping] = useState<string | null>(null);
  const toast = useToast();
  const now = useNow(15_000);

  const load = useCallback(() => api.card(tokenId).then(setCard, (e) => setError(e.message)), [tokenId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!card) {
    return (
      <main className="page">
        {error ? <div className="empty"><h1 className="display">We can't find that card</h1><p className="lede">{error}</p><a className="btn btn--primary" href="#/">Back to the packs</a></div> : (
          <div className="card-page__grid">
            <Skeleton style={{ aspectRatio: "5 / 8", display: "block", borderRadius: 18 }} />
            <div className="stack"><Skeleton style={{ height: 22, width: 160 }} /><Skeleton style={{ height: 64 }} /><Skeleton style={{ height: 180 }} /><Skeleton style={{ height: 280 }} /></div>
          </div>
        )}
      </main>
    );
  }

  const isOwner = wallet?.accountId === card.owner_id;
  const rarity = rarityOf(card.record.rarity);
  const s = card.record.status;
  const proceeds = units(card.proceedsUnits);
  const lockedUntil = Number(card.locked_until_ms);
  const lockedMinutes = lockedUntil > now ? Math.ceil((lockedUntil - now) / 60000) : 0;
  const busy = status !== null;
  const offer = card.offer;
  const expires = offer ? timeLeft(offer.expiresAt) : null;
  const available = ACTIONS.filter((a) => (a.key === "transfer" ? card.transferable : s === "Opened" && (a.key !== "sellback" || offer)));

  const reset = () => {
    setAction(null);
    setOp(null);
    setDestination("");
    setPayout(DIRECT);
  };

  const chosen = payouts.find((a) => a.assetId === payout);
  const usdcOnSolana: PayAsset = { assetId: DIRECT, symbol: "USDC", chain: "sol", decimals: 6 } as PayAsset;
  const payoutChain = chosen?.chain ?? "sol";

  const prepare = async (a: Action) => {
    setAction(a);
    setError(null);
    setDone(null);
    setOp(null);
    if (a === "cashOut" && !payouts.length) {
      api.cashOutAssets().then((list) => setPayouts(rankAssets(list).filter((x) => !(x.chain === "sol" && x.symbol === "USDC"))), () => undefined);
    }
    if (a === "cashOut") setDestination(addressFor("sol", loginWallet));
    if (a === "sellback") {
      setStatus({ text: "Getting Collector Crypt's offer…", since: Date.now() });
      try {
        setOp(await api.sellback(tokenId, wallet!.accountId));
      } catch (e) {
        setError(refusal(e));
        reset();
      } finally {
        setStatus(null);
      }
    }
  };

  const signAndSend = async (prepared: Op, intent: SigningIntent, text: string) => {
    setStatus({ text: "Checking the transaction, then signing on NEAR", since: Date.now() });
    const sig = await wallet!.signForCard(tokenId, prepared.message_hex, intent);
    setStatus({ text: "Signed. Sending on Solana", since: Date.now() });
    const finished = await api.finalize(prepared.id, sig);
    await load();
    setDone({ text, tx: finished.tx_sig ?? undefined });
    toast("Done");
    reset();
  };

  const confirm = async () => {
    setError(null);
    try {
      if (action === "transfer") {
        setStatus({ text: "Transferring the NFT on NEAR", since: Date.now() });
        await wallet!.transfer(tokenId, destination.trim());
        await load();
        setDone({ text: "The NFT is transferred. Its new owner now controls the card, and the card didn't move." });
        toast("NFT transferred");
        reset();
      } else if (action === "sellback") {
        const units = sellbackPrice(op!.message_hex);
        if (units === null) throw new Error("no price in this offer");
        const price = Number(units) / 1e6;
        await signAndSend(op!, { kind: "sellback", price: units }, `Sold back. ${usd(price)} USDC is now held by this NFT's address. Withdraw it whenever you like.`);
      } else if (action === "withdrawCard") {
        setStatus({ text: "Preparing the transfer", since: Date.now() });
        await signAndSend(await api.withdrawCard(tokenId, wallet!.accountId, destination.trim()), { kind: "withdrawCard", destination: destination.trim() }, "The card is in your wallet. You can now redeem the physical card on Collector Crypt's site, or list it on a marketplace.");
      } else if (action === "cashOut" && payout === DIRECT) {
        setStatus({ text: "Preparing the withdrawal", since: Date.now() });
        await signAndSend(await api.withdrawProceeds(tokenId, wallet!.accountId, destination.trim()), { kind: "withdrawUsdc", destination: destination.trim(), amount: card.proceedsUnits }, "The USDC is on its way to your address.");
      } else if (action === "cashOut" && op) {
        const prepared = op;
        const d = JSON.parse(prepared.detail) as { depositAddress: string; quote: unknown };
        await signAndSend(prepared, { kind: "cashOut", recipient: destination.trim(), destinationAsset: payout, amount: card.proceedsUnits, depositAddress: d.depositAddress, quote: d.quote }, "Your USDC has been sent to the swap.");
        setSwapping(prepared.id);
      } else if (action === "cashOut") {
        // Two steps: show what they'll receive first, and only ask for a signature after that.
        setStatus({ text: "Getting a quote", since: Date.now() });
        try {
          setOp(await api.cashOut(tokenId, wallet!.accountId, payout, destination.trim()));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    } catch (e) {
      setError(refusal(e));
      setStatus(null);
      await load();
    } finally {
      setStatus(null);
    }
  };

  // Read from the message itself, so this is the number that gets signed.
  const quotedUnits = op && action === "sellback" ? sellbackPrice(op.message_hex) : null;
  const quoted = quotedUnits === null ? null : Number(quotedUnits) / 1e6;

  return (
    <motion.main className={`page card-page card-page--${rarity}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className={`card-glow card-glow--${rarity}`} aria-hidden="true" />
      <a className="back" href="#/dashboard"><ArrowLeft size={15} aria-hidden="true" /> Your dashboard</a>
      <div className="card-page__grid">
        <figure className="slab">
          <Tilt foil={rarity} max={13} className="slab__frame">
            {card.image && <img src={card.image} alt={card.name ?? `Graded card, token ${tokenId}`} className={imgLoaded ? "is-loaded" : ""} onLoad={() => setImgLoaded(true)} />}
            {!card.image && <span className="slab__sealed">Sealed</span>}
          </Tilt>
        </figure>

        <div className="stack stack--lg">
          <header>
            <div className="card-page__meta">
              <RarityBadge rarity={rarity} />
              <span className="eyebrow">Token {card.token_id} · {statusLabel(card)}</span>
            </div>
            <h1 className="card-page__name">{card.name ?? `${card.record.rarity ?? "Sealed"} pull`}</h1>
            <p className="card-page__value tabular">{usd(insured(card))} <small>Collector Crypt insured value</small></p>
          </header>

          <AnimatePresence>
            {done && (
              <motion.p className="ok" role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <Check size={17} aria-hidden="true" /> <span>{done.text} {done.tx && <Ext href={solanaTx(done.tx, health.network)}>View transaction</Ext>}</span>
              </motion.p>
            )}
          </AnimatePresence>
          {error && <p className="error" role="alert">{error}</p>}
          {status && <SigningProgress text={status.text} since={status.since} />}
          {swapping && <CashOutProgress opId={swapping} isTest={health.network === "testnet"} onDone={load} />}

          {s === "Exiting" && <p className="note"><Lock size={15} aria-hidden="true" /> This card is leaving this NFT, so the NFT can't be transferred until that's settled.</p>}
          {lockedMinutes > 0 && s !== "Exiting" && <p className="note"><Lock size={15} aria-hidden="true" /> NFT transfers are locked for about {lockedMinutes} more minute{lockedMinutes === 1 ? "" : "s"}. A recent signature could still be used, and the lock protects whoever gets this NFT next.</p>}
          {!isOwner && <p className="note">Only this NFT's owner can act on it.</p>}

          {isOwner && offer && s === "Opened" && !action && (
            <div className="offer panel">
              <div>
                <p className="eyebrow">Collector Crypt's offer</p>
                <p className="offer__amount tabular">{usd(units(offer.amountUnits))} <small>USDC</small></p>
              </div>
              {expires && <p className="offer__clock">Ends in <strong className="tabular">{expires}</strong></p>}
            </div>
          )}

          {isOwner && !action && !busy && (
            <div className="actions-grid">
              {proceeds > 0 && (
                <motion.button whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} className="action action--primary" onClick={() => prepare("cashOut")}>
                  <Wallet size={20} aria-hidden="true" />
                  <span><strong>Cash out {usd(proceeds)} USDC</strong><small>To any coin, on any chain</small></span>
                </motion.button>
              )}
              {available.map((a) => (
                <motion.button key={a.key} whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} className={`action ${a.key === "sellback" ? "action--primary" : ""}`} onClick={() => prepare(a.key)}>
                  {a.icon}
                  <span><strong>{a.title}</strong><small>{a.desc}</small></span>
                </motion.button>
              ))}
            </div>
          )}

          <AnimatePresence>
            {isOwner && action && !busy && (action !== "sellback" || op) && (
              <motion.div className="confirm panel" initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.28, ease: EASE }}>
                <button className="icon-btn confirm__close" onClick={reset} aria-label="Cancel"><X size={16} aria-hidden="true" /></button>
                {action === "sellback" && quoted === null && <p className="error" role="alert">This offer can't be read, so it can't be signed. Please try again.</p>}
                {action === "sellback" && quoted !== null && <p>Collector Crypt offers <strong>{usd(quoted)} USDC</strong> for this card. The card goes back to them, and the money lands in this NFT's address. You can't undo this.</p>}
                {action === "withdrawCard" && <p>Moves the real card to your own Solana wallet. You'll need that wallet to redeem the physical card on Collector Crypt's site. This NFT will no longer hold a card.</p>}
                {action === "cashOut" && !op && <>
                  <p>Cash out <strong>{usd(proceeds)} USDC</strong> as any coin, on any chain.</p>
                  <AssetPicker legend="Receive" assets={[usdcOnSolana, ...payouts]} value={payout} onChange={(id) => {
                    setPayout(id);
                    setDestination(addressFor(id === DIRECT ? "sol" : payouts.find((a) => a.assetId === id)?.chain, loginWallet));
                  }} />
                </>}
                {action === "cashOut" && op && (() => {
                  const d = JSON.parse(op.detail) as CashOutDetail;
                  return (
                    <div className="stack" data-cashout="quote">
                      <p>You send <strong>{usd(proceeds)} USDC</strong> and receive about <strong>{coin(d.amountOut, d)} {d.symbol}</strong> on {chainLabel(d)}{d.minAmountOut ? `, and at least ${coin(d.minAmountOut, d)} ${d.symbol}` : ""}.</p>
                      <p className="hint">To <code>{d.recipient}</code>{d.timeEstimateSeconds ? `. Takes about ${Math.max(1, Math.round(d.timeEstimateSeconds / 60))} min` : ""}. If the swap can't complete, the money is refunded{health.network === "testnet" ? " to the test treasury" : " to this NFT's address"}.</p>
                    </div>
                  );
                })()}
                {action === "transfer" && <p>The new owner controls the card from the moment this completes, and you lose access. Nothing moves on Solana.</p>}

                {action !== "sellback" && (
                  <div className="field" hidden={action === "cashOut" && Boolean(op)}>
                    <label htmlFor="dest">{action === "transfer" ? "New owner's NEAR account" : `Your ${chainLabel({ chain: action === "cashOut" ? payoutChain : "sol" })} address`}</label>
                    <input id="dest" value={destination} onChange={(e) => setDestination(e.target.value)} autoComplete="off" spellCheck={false} />
                  </div>
                )}
                <div className="actions">
                  <button className="btn btn--primary" disabled={(action !== "sellback" && !destination.trim()) || (action === "sellback" && quoted === null)} onClick={confirm}>{action === "cashOut" && payout !== DIRECT && !op ? "Get quote" : "Confirm"}</button>
                  <button className="btn btn--ghost" onClick={reset}>Cancel</button>
                </div>
                {action !== "transfer" && (action !== "cashOut" || payout === DIRECT || op) && <p className="hint">Confirming locks NFT transfers for 5 minutes.</p>}
              </motion.div>
            )}
          </AnimatePresence>

          <Proof card={card} health={health} />
        </div>
      </div>
    </motion.main>
  );
}
