// The Keeper: let an agent sell this card back for you while Collector Crypt's offer meets your minimum, straight away or only
// near the end of the offer, and then send the USDC to your own Solana address. The contract limits it to exactly that.
// Laid out for someone who has never heard of it: what it does in one line, how in three steps, then four plain questions,
// and a sentence that says exactly what will happen before anything is signed.
import { AnimatePresence, motion } from "motion/react";
import { Bot, Check, ChevronDown, Clock, Eye, Hourglass, Landmark, ShieldCheck, Tag, Wallet, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { LoginWallet } from "./privy";
import { insured, short, timeAgo, units, usd, type Card } from "./api";
import { refusal, type Wallet as WalletT } from "./wallet";
import { EASE } from "./ui";

const DURATIONS: [string, number][] = [["1 day", 1], ["7 days", 7], ["30 days", 30], ["60 days", 60]];
const DAY = 24 * 60 * 60 * 1000;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FEE_BPS = 100;
const FEE_MIN = 0.25;
const fee = (amount: number) => Math.max(Math.ceil(amount * FEE_BPS) / 10_000, FEE_MIN);
const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function Question({ n, title, hint, children }: { n: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="kq">
      <div className="kq__head">
        <span className="kq__n" aria-hidden="true">{n}</span>
        <div>
          <h3>{title}</h3>
          {hint && <p className="hint">{hint}</p>}
        </div>
      </div>
      <div className="kq__body">{children}</div>
    </div>
  );
}

function Choice({ name, checked, onChange, icon, title, body }: { name: string; checked: boolean; onChange: () => void; icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <label className={`kchoice ${checked ? "is-on" : ""}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className="kchoice__icon" aria-hidden="true">{icon}</span>
      <span className="kchoice__text"><strong>{title}</strong><span>{body}</span></span>
      <span className="kchoice__tick" aria-hidden="true"><Check size={14} /></span>
    </label>
  );
}

function Limits({ agent }: { agent: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="klimits">
      <button className="klimits__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShieldCheck size={16} aria-hidden="true" /> What the Keeper can't do, even if someone steals its key
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="klimits__chev"><ChevronDown size={15} aria-hidden="true" /></motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="klimits__body">
            <ul>
              <li>Withdraw your card, or move it anywhere but back to Collector Crypt.</li>
              <li>Sell for less than your lowest price, or after the end date.</li>
              <li>Send the money anywhere but this NFT or the address you chose. Mintent's fee is fixed at 1%, at least $0.25.</li>
              <li>Transfer this NFT. Selling or giving away the NFT turns the Keeper off.</li>
            </ul>
            <p className="hint">The Mintent contract on NEAR checks every transaction the Keeper asks it to sign, and the Keeper's key ({short(agent, 10)}) can't call anything else. You can check every action it took with <code>pnpm verify:keeper</code>.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const STAGES = ["Watching", "Selling", "Paying you", "Done"];

export function KeeperPanel({ card, wallet, agent, loginWallet, onChange }: { card: Card; wallet: WalletT; agent: string; loginWallet: LoginWallet | null; onChange: () => void }) {
  const grant = card.keeper && card.keeper.agent === agent && Number(card.keeper.expires_ms) > Date.now() ? card.keeper : null;
  const offer = card.offer ? units(card.offer.amountUnits) : null;
  const offerEnds = card.offer?.expiresAt ? new Date(card.offer.expiresAt).getTime() : null;
  const [minimum, setMinimum] = useState(offer ? offer.toFixed(2) : "");
  const [hold, setHold] = useState(false);
  const [days, setDays] = useState(7);
  const solanaLogin = loginWallet?.chainType === "solana" ? loginWallet.address : "";
  const [payoutOn, setPayoutOn] = useState(Boolean(solanaLogin));
  const [payout, setPayout] = useState(solanaLogin);
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
  // Hold mode has to last until the offer's last day, so its end follows the offer.
  const holdDays = offerEnds ? Math.min(60, Math.max(1, Math.ceil((offerEnds - Date.now()) / DAY) + 1)) : 7;
  const effectiveDays = hold ? Math.max(days, holdDays) : days;
  const ends = Date.now() + effectiveDays * DAY;
  const payoutValid = !payoutOn || SOLANA.test(payout.trim());
  const valid = Number.isFinite(minUnits) && minUnits > 0 && payoutValid;
  const status = card.keeperStatus;
  const presets = offer ? [["Today's offer", offer], ["5% under", Math.floor(offer * 95) / 100], ["10% under", Math.floor(offer * 90) / 100]] as const : [];

  if (grant) {
    const sold = card.record.status !== "Opened";
    const paid = sold && Number(card.proceedsUnits) === 0;
    const stage = paid ? 3 : sold ? (grant.payout ? 2 : 3) : /^Selling/.test(status?.detail ?? "") ? 1 : 0;
    const gmin = units(grant.min_price);
    return (
      <section className="panel keeper keeper--on" data-keeper="on" aria-labelledby="keeper-title">
        <header className="keeper__head">
          <span className="keeper__badge keeper__badge--on"><span className="keeper__pulse" aria-hidden="true" /> On</span>
          <h2 id="keeper-title"><Bot size={18} aria-hidden="true" /> Keeper</h2>
        </header>

        {status ? (
          <div className="keeper__status" data-keeper-status={status.action} role="status">
            <span className="keeper__thought" aria-hidden="true"><Bot size={16} /></span>
            <p>{status.detail}</p>
            <small>{timeAgo(status.at)}</small>
          </div>
        ) : (
          <div className="keeper__status" role="status">
            <span className="keeper__thought" aria-hidden="true"><Bot size={16} /></span>
            <p>Starting up. It checks Collector Crypt's offer about every 30 seconds.</p>
          </div>
        )}

        <ol className="keeper__track" aria-label="Progress">
          {STAGES.map((s, i) => (i === 2 && !grant.payout ? null : (
            <li key={s} className={i < stage ? "is-done" : i === stage ? "is-now" : ""}>
              <span aria-hidden="true">{i < stage ? <Check size={12} /> : i + 1}</span>{s}
            </li>
          )))}
        </ol>

        <dl className="keeper__rules">
          <div><dt><Tag size={14} aria-hidden="true" /> Lowest price</dt><dd>{usd(gmin)}</dd></div>
          <div><dt>{grant.hold ? <Hourglass size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />} When</dt><dd>{grant.hold ? "In the offer's last 24 hours" : "As soon as the offer is high enough"}</dd></div>
          <div><dt><Clock size={14} aria-hidden="true" /> Until</dt><dd>{dateTime(Number(grant.expires_ms))}</dd></div>
          <div><dt><Wallet size={14} aria-hidden="true" /> Money goes to</dt><dd>{grant.payout ? <><code>{short(grant.payout, 6)}</code> on Solana</> : "This NFT, to cash out later"}</dd></div>
        </dl>

        <button className="btn btn--ghost btn--full" disabled={busy} onClick={() => run(() => wallet.revokeKeeper(card.token_id))}>{busy ? "Turning off…" : "Turn off the Keeper"}</button>
        <Limits agent={agent} />
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    );
  }

  const willGet = payoutOn && min > 0 ? Math.max(min - fee(min), 0) : null;
  return (
    <section className="panel keeper" data-keeper="off" aria-labelledby="keeper-title">
      <header className="keeper__head">
        <span className="keeper__badge">Off</span>
        <h2 id="keeper-title"><Bot size={18} aria-hidden="true" /> Keeper</h2>
      </header>
      <p className="keeper__lede">An agent that sells this card back for you, so you don't miss Collector Crypt's offer before it ends.</p>

      <ol className="keeper__how">
        <li><span aria-hidden="true"><Tag size={16} /></span><strong>You set a lowest price</strong><small>and how long it can act</small></li>
        <li><span aria-hidden="true"><Eye size={16} /></span><strong>It watches the offer</strong><small>about every 30 seconds</small></li>
        <li><span aria-hidden="true"><Landmark size={16} /></span><strong>It sells, then pays you</strong><small>only within your rules</small></li>
      </ol>

      {offer !== null ? (
        <p className="keeper__offer">Today's offer is <strong>{usd(offer)}</strong>, about 85% of the {usd(insured(card))} insured value{offerEnds ? <>, and it ends <strong>{date(offerEnds)}</strong></> : null}.</p>
      ) : (
        <p className="note keeper__offer">There's no sell-back offer for this card right now. The Keeper can wait for one.</p>
      )}

      <Question n={1} title="When should it sell?">
        <div className="kchoices" role="radiogroup" aria-label="When to sell">
          <Choice name="keeper-mode" checked={!hold} onChange={() => setHold(false)} icon={<Zap size={17} />} title="As soon as the offer is high enough" body="Sells the moment the offer meets your price." />
          <Choice name="keeper-mode" checked={hold} onChange={() => setHold(true)} icon={<Hourglass size={17} />} title="Keep the card, sell at the last minute" body={offerEnds ? `Holds it, and sells in the offer's last 24 hours, from ${date(offerEnds - DAY)}.` : "Holds it, and sells in the offer's last 24 hours."} />
        </div>
      </Question>

      <Question n={2} title="What's the lowest price you'll accept?">
        <div className="kprice">
          <label className="kprice__field">
            <span className="sr-only">Lowest price in USDC</span>
            <span aria-hidden="true">$</span>
            <input id="keeper-min" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="kprice__unit" aria-hidden="true">USDC</span>
          </label>
          {presets.length > 0 && (
            <div className="kchips" role="group" aria-label="Suggested prices">
              {presets.map(([label, v]) => (
                <button key={label} type="button" className={`kchip ${Math.abs(min - v) < 0.005 ? "is-on" : ""}`} onClick={() => setMinimum(v.toFixed(2))}>{label} <span className="tabular">{usd(v)}</span></button>
              ))}
            </div>
          )}
        </div>
        {offer !== null && min > offer + 0.004 && <p className="hint kwarn">That's above today's offer, so it will wait unless the offer rises.</p>}
      </Question>

      <Question n={3} title="How long should it stay on?" hint={hold && offerEnds ? `Keep-the-card mode stays on at least until the offer ends, ${date(offerEnds)}.` : undefined}>
        <div className="kchips" role="radiogroup" aria-label="How long">
          {DURATIONS.map(([label, d]) => (
            <label key={d} className={`kchip ${effectiveDays === d ? "is-on" : ""} ${hold && d < holdDays ? "is-off" : ""}`}>
              <input type="radio" name="keeper-days" value={d} checked={days === d} disabled={hold && d < holdDays} onChange={() => setDays(d)} />
              {label}
            </label>
          ))}
        </div>
        <p className="hint">Until <strong>{dateTime(ends)}</strong>. You can turn it off any time before.</p>
      </Question>

      <Question n={4} title="Where should the money go?">
        <div className="kchoices" role="radiogroup" aria-label="Where the money goes">
          <Choice name="keeper-payout-mode" checked={!payoutOn} onChange={() => setPayoutOn(false)} icon={<Landmark size={17} />} title="Keep it in this NFT" body="Cash it out later, as any coin on any chain." />
          <Choice name="keeper-payout-mode" checked={payoutOn} onChange={() => setPayoutOn(true)} icon={<Wallet size={17} />} title="Send it to my Solana wallet" body="Paid automatically, as USDC, less Mintent's 1% fee." />
        </div>
        {payoutOn && (
          <div className="field">
            <label htmlFor="keeper-payout">Your Solana address</label>
            <input id="keeper-payout" value={payout} onChange={(e) => setPayout(e.target.value.trim())} autoComplete="off" spellCheck={false} placeholder="e.g. 7xKX…sAsU" aria-invalid={payout.length > 0 && !payoutValid} />
            {payout.length > 0 && !payoutValid && <p className="error">That doesn't look like a Solana address.</p>}
          </div>
        )}
      </Question>

      <div className="keeper__summary" aria-live="polite">
        <p className="eyebrow">What will happen</p>
        {valid ? (
          <p>
            The Keeper will sell this card to Collector Crypt for at least <strong>{usd(min)}</strong>
            {hold ? <>, in the offer's last 24 hours</> : <>, as soon as the offer allows</>}, until <strong>{date(ends)}</strong>.{" "}
            {payoutOn ? <>Then it sends you at least <strong>{usd(willGet!)}</strong> at <code>{short(payout, 5)}</code>, after Mintent's fee.</> : <>The money stays in this NFT for you to cash out.</>}
          </p>
        ) : (
          <p className="hint">Set a price{payoutOn ? " and a Solana address" : ""} to see exactly what it will do.</p>
        )}
      </div>

      <button className="btn btn--primary btn--full" disabled={busy || !valid} onClick={() => run(() => wallet.grantKeeper(card.token_id, agent, BigInt(minUnits), ends, { payout: payoutOn ? payout.trim() : undefined, hold }))}>
        {busy ? "Turning on…" : "Turn on the Keeper"}
      </button>
      <p className="hint keeper__fine">You approve this once. It can't be changed while on: turn it off and on again to change it.</p>
      <Limits agent={agent} />
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
