// A card: what it is, where it really is, the proof, and what its owner can do with it.
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowLeftRight, Check, ExternalLink, Lock, ShieldCheck, Truck, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, insured, nearAcct, rarityOf, short, solanaAddr, solanaTx, statusLabel, timeLeft, units, usd, type Card, type Health, type Op } from "./api";
import { CopyButton, EASE, RarityBadge, Skeleton, Tilt, useNow, useToast } from "./ui";
import { refusal, type Wallet as WalletT } from "./wallet";

type Action = "sellback" | "withdrawCard" | "withdrawProceeds" | "transfer";

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

export function CardPage({ tokenId, health, wallet }: { tokenId: string; health: Health; wallet: WalletT | null }) {
  const [card, setCard] = useState<Card | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [destination, setDestination] = useState("");
  const [op, setOp] = useState<Op | null>(null);
  const [status, setStatus] = useState<{ text: string; since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; tx?: string } | null>(null);
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
  };

  const prepare = async (a: Action) => {
    setAction(a);
    setError(null);
    setDone(null);
    setOp(null);
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

  const signAndSend = async (prepared: Op, text: string) => {
    setStatus({ text: "Signing on NEAR", since: Date.now() });
    const sig = await wallet!.signForCard(tokenId, prepared.message_hex);
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
        const price = Number(JSON.parse(op!.detail).price) / 1e6;
        await signAndSend(op!, `Sold back. ${usd(price)} USDC is now held by this NFT's address. Withdraw it whenever you like.`);
      } else if (action === "withdrawCard") {
        setStatus({ text: "Preparing the transfer", since: Date.now() });
        await signAndSend(await api.withdrawCard(tokenId, wallet!.accountId, destination.trim()), "The card is in your wallet. You can now redeem the physical card on Collector Crypt's site, or list it on a marketplace.");
      } else if (action === "withdrawProceeds") {
        setStatus({ text: "Preparing the withdrawal", since: Date.now() });
        await signAndSend(await api.withdrawProceeds(tokenId, wallet!.accountId, destination.trim()), "The USDC is on its way to your address.");
      }
    } catch (e) {
      setError(refusal(e));
      await load();
    } finally {
      setStatus(null);
    }
  };

  const quoted = op && action === "sellback" ? Number(JSON.parse(op.detail).price) / 1e6 : null;

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
                <motion.button whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} className="action action--primary" onClick={() => prepare("withdrawProceeds")}>
                  <Wallet size={20} aria-hidden="true" />
                  <span><strong>Withdraw {usd(proceeds)} USDC</strong><small>Held by this NFT's address</small></span>
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
                {action === "sellback" && quoted !== null && <p>Collector Crypt offers <strong>{usd(quoted)} USDC</strong> for this card. The card goes back to them, and the money lands in this NFT's address. You can't undo this.</p>}
                {action === "withdrawCard" && <p>Moves the real card to your own Solana wallet. You'll need that wallet to redeem the physical card on Collector Crypt's site. This NFT will no longer hold a card.</p>}
                {action === "withdrawProceeds" && <p>Sends <strong>{usd(proceeds)} USDC</strong> to a Solana address you choose.</p>}
                {action === "transfer" && <p>The new owner controls the card from the moment this completes, and you lose access. Nothing moves on Solana.</p>}

                {action !== "sellback" && (
                  <div className="field">
                    <label htmlFor="dest">{action === "transfer" ? "New owner's NEAR account" : "Your Solana address"}</label>
                    <input id="dest" value={destination} onChange={(e) => setDestination(e.target.value)} autoComplete="off" spellCheck={false} />
                  </div>
                )}
                <div className="actions">
                  <button className="btn btn--primary" disabled={action !== "sellback" && !destination.trim()} onClick={confirm}>Confirm</button>
                  <button className="btn btn--ghost" onClick={reset}>Cancel</button>
                </div>
                {action !== "transfer" && <p className="hint">Confirming locks NFT transfers for 5 minutes.</p>}
              </motion.div>
            )}
          </AnimatePresence>

          <Proof card={card} health={health} />
        </div>
      </div>
    </motion.main>
  );
}
