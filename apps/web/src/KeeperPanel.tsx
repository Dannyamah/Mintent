// The Keeper: let an agent sell this card back for you while Collector Crypt's offer meets your minimum, straight away or only
// near the end of the offer, and then send the USDC to your own Solana address. The contract limits it to exactly that.
// One tap to turn on: pick "sell now" or "wait for the deadline", and today's offer is the minimum. Everything else sits in
// one line of settings, opened only by people who want to change something.
import { AnimatePresence, motion } from "motion/react";
import { Bot, ChevronDown, Hourglass, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";
import type { LoginWallet } from "./privy";
import { short, timeAgo, units, usd, type Card } from "./api";
import { refusal, type Wallet as WalletT } from "./wallet";
import { EASE } from "./ui";

const DURATIONS: [string, number][] = [["1 day", 1], ["7 days", 7], ["30 days", 30], ["60 days", 60]];
const DAY = 24 * 60 * 60 * 1000;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const fee = (amount: number) => Math.max(Math.ceil(amount * 100) / 10_000, 0.25);
const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div className="kfold" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.24, ease: EASE }}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Limits({ agent }: { agent: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="klimits">
      <button className="klimits__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShieldCheck size={15} aria-hidden="true" /> What it can't do, even with a stolen key
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="klimits__chev"><ChevronDown size={15} aria-hidden="true" /></motion.span>
      </button>
      <Fold open={open}>
        <ul className="klimits__list">
          <li>Withdraw your card, or send it anywhere but back to Collector Crypt.</li>
          <li>Sell below your minimum, or after the end date.</li>
          <li>Send money anywhere but this NFT or your chosen address, or take more than Mintent's 1% fee (at least $0.25).</li>
          <li>Transfer this NFT. Selling or giving it away turns the Keeper off.</li>
        </ul>
        <p className="klimits__note">The Mintent contract checks everything the Keeper ({short(agent, 10)}) asks it to sign, and the Keeper's key can't call anything else.</p>
      </Fold>
    </div>
  );
}

const STAGES = ["Watching", "Selling", "Paying you", "Done"];

export function KeeperPanel({ card, wallet, agent, loginWallet, onChange }: { card: Card; wallet: WalletT; agent: string; loginWallet: LoginWallet | null; onChange: () => void }) {
  const grant = card.keeper && card.keeper.agent === agent && Number(card.keeper.expires_ms) > Date.now() ? card.keeper : null;
  const offer = card.offer ? units(card.offer.amountUnits) : null;
  const offerEnds = card.offer?.expiresAt ? new Date(card.offer.expiresAt).getTime() : null;
  const solanaLogin = loginWallet?.chainType === "solana" ? loginWallet.address : "";
  const [hold, setHold] = useState(false);
  const [minimum, setMinimum] = useState(offer ? offer.toFixed(2) : "");
  const [days, setDays] = useState(7);
  const [payoutOn, setPayoutOn] = useState(Boolean(solanaLogin));
  const [payout, setPayout] = useState(solanaLogin);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      onChange();
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(false);
    }
  };

  const min = Number(minimum);
  const minUnits = Math.round(min * 1e6);
  // "Wait for the deadline" has to stay on until the offer's last day, so its end follows the offer.
  const holdDays = offerEnds ? Math.min(60, Math.max(1, Math.ceil((offerEnds - Date.now()) / DAY) + 1)) : 7;
  const effectiveDays = hold ? Math.max(days, holdDays) : days;
  const ends = Date.now() + effectiveDays * DAY;
  const payoutValid = !payoutOn || SOLANA.test(payout.trim());
  const priceValid = Number.isFinite(minUnits) && minUnits > 0;
  const valid = priceValid && payoutValid;
  const status = card.keeperStatus;

  if (grant) {
    const sold = card.record.status !== "Opened";
    const paid = sold && Number(card.proceedsUnits) === 0;
    const stage = paid ? 3 : sold ? (grant.payout ? 2 : 3) : /^Selling/.test(status?.detail ?? "") ? 1 : 0;
    const stages = STAGES.filter((_, i) => i !== 2 || grant.payout);
    const at = stages.indexOf(STAGES[stage]);
    return (
      <section className="panel keeper keeper--on" data-keeper="on" aria-labelledby="keeper-title">
        <header className="keeper__head">
          <h2 id="keeper-title"><Bot size={17} aria-hidden="true" /> Keeper</h2>
          <span className="keeper__badge keeper__badge--on"><span className="keeper__pulse" aria-hidden="true" /> On</span>
        </header>
        <div className="keeper__status" data-keeper-status={status?.action} role="status">
          <p>{status?.detail ?? "Starting up. It checks the offer about every 30 seconds."}</p>
          {status && <small>{timeAgo(status.at)}</small>}
        </div>
        <ol className="keeper__track" aria-label="Progress">
          {stages.map((s, i) => <li key={s} className={i < at ? "is-done" : i === at ? "is-now" : ""}>{s}</li>)}
        </ol>
        <p className="keeper__rules">
          At least <strong>{usd(units(grant.min_price))}</strong> · {grant.hold ? "in the offer's last day" : "as soon as it can"} · until <strong>{date(Number(grant.expires_ms))}</strong> · {grant.payout ? <>pays <code>{short(grant.payout, 4)}</code></> : "money stays in this NFT"}
        </p>
        <button className="btn btn--ghost btn--full btn--compact" disabled={busy} onClick={() => run(() => wallet.revokeKeeper(card.token_id))}>{busy ? "Turning off…" : "Turn off the Keeper"}</button>
        <Limits agent={agent} />
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    );
  }

  const presets = offer ? [["Offer", offer], ["−5%", Math.floor(offer * 95) / 100], ["−10%", Math.floor(offer * 90) / 100]] as const : [];
  return (
    <section className="panel keeper" data-keeper="off" aria-labelledby="keeper-title">
      <header className="keeper__head">
        <h2 id="keeper-title"><Bot size={17} aria-hidden="true" /> Keeper</h2>
        <span className="keeper__badge">Off</span>
      </header>
      <p className="keeper__lede">
        Sells this card back for you, so you don't miss Collector Crypt's offer{offer !== null ? <> of <strong>{usd(offer)}</strong></> : ""}{offerEnds ? <> before it ends on <strong>{date(offerEnds)}</strong></> : ""}.
      </p>

      <div className="kmode" role="radiogroup" aria-label="When to sell">
        <label className={`kmode__opt ${!hold ? "is-on" : ""}`}>
          <input type="radio" name="keeper-mode" checked={!hold} onChange={() => setHold(false)} />
          <Zap size={16} aria-hidden="true" />
          <span><strong>Sell now</strong><small>as soon as the offer is high enough</small></span>
        </label>
        <label className={`kmode__opt ${hold ? "is-on" : ""}`}>
          <input type="radio" name="keeper-mode" checked={hold} onChange={() => setHold(true)} />
          <Hourglass size={16} aria-hidden="true" />
          <span><strong>Wait for the deadline</strong><small>keep it, sell in the offer's last day</small></span>
        </label>
      </div>

      <div className="ksettings">
        <p className="keeper__summary" aria-live="polite">
          {hold ? "In the offer's last day" : "As soon as it can"}
          {" · "}{priceValid ? <>at least <strong>{usd(min)}</strong></> : <span className="kwarn">set a minimum</span>}
          {" · "}until <strong>{date(ends)}</strong>
          {" · "}{payoutOn ? (payoutValid && payout ? <>pays <code>{short(payout, 4)}</code>{priceValid && <> (≥ {usd(Math.max(min - fee(min), 0))})</>}</> : <span className="kwarn">add your Solana address</span>) : "money stays in this NFT"}
        </p>
        <button type="button" className="ksettings__edit" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? "Done" : "Change"}</button>
      </div>

      <Fold open={editing || (payoutOn && !payoutValid && payout.length > 0)}>
        <div className="kedit">
          <div className="kedit__row">
            <label htmlFor="keeper-min" className="kedit__label">Lowest price</label>
            <div className="kprice">
              <span aria-hidden="true">$</span>
              <input id="keeper-min" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            {presets.map(([label, v]) => (
              <button key={label} type="button" className={`kchip ${Math.abs(min - v) < 0.005 ? "is-on" : ""}`} onClick={() => setMinimum(v.toFixed(2))}>{label}</button>
            ))}
          </div>
          {offer !== null && min > offer + 0.004 && <p className="kedit__note kwarn">Above today's offer: it waits unless the offer rises.</p>}
          <div className="kedit__row" role="radiogroup" aria-label="How long">
            <span className="kedit__label">Stay on for</span>
            {DURATIONS.map(([label, d]) => (
              <label key={d} className={`kchip ${effectiveDays === d ? "is-on" : ""} ${hold && d < holdDays ? "is-off" : ""}`}>
                <input type="radio" name="keeper-days" value={d} checked={days === d} disabled={hold && d < holdDays} onChange={() => setDays(d)} />
                {label}
              </label>
            ))}
          </div>
          <div className="kedit__row" role="radiogroup" aria-label="Where the money goes">
            <span className="kedit__label">Money</span>
            <label className={`kchip ${!payoutOn ? "is-on" : ""}`}><input type="radio" name="keeper-payout-mode" checked={!payoutOn} onChange={() => setPayoutOn(false)} />Keep in this NFT</label>
            <label className={`kchip ${payoutOn ? "is-on" : ""}`}><input type="radio" name="keeper-payout-mode" checked={payoutOn} onChange={() => setPayoutOn(true)} />Send it to my Solana wallet</label>
          </div>
          {payoutOn && (
            <div className="kedit__addr">
              <label htmlFor="keeper-payout" className="sr-only">Your Solana address</label>
              <input id="keeper-payout" value={payout} onChange={(e) => setPayout(e.target.value.trim())} autoComplete="off" spellCheck={false} placeholder="Your Solana address" aria-invalid={payout.length > 0 && !payoutValid} />
              {payout.length > 0 && !payoutValid && <p className="kedit__note kwarn">That doesn't look like a Solana address.</p>}
            </div>
          )}
        </div>
      </Fold>

      <button className="btn btn--primary btn--full" disabled={busy || !valid} onClick={() => run(() => wallet.grantKeeper(card.token_id, agent, BigInt(minUnits), ends, { payout: payoutOn ? payout.trim() : undefined, hold }))}>
        {busy ? "Turning on…" : "Turn on the Keeper"}
      </button>
      <Limits agent={agent} />
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
