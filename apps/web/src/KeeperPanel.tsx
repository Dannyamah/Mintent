// The Keeper: let an agent sell this card back for you while Collector Crypt's offer meets your minimum, straight away or only
// near the end of the offer, and then send the USDC to your own Solana address. The contract limits it to exactly that.
import { Bot, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { LoginWallet } from "./privy";
import { short, timeAgo, units, usd, type Card } from "./api";
import { refusal, type Wallet } from "./wallet";

const DURATIONS: [string, number][] = [["1 day", 1], ["7 days", 7], ["30 days", 30], ["60 days", 60]];
const DAY = 24 * 60 * 60 * 1000;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function KeeperPanel({ card, wallet, agent, loginWallet, onChange }: { card: Card; wallet: Wallet; agent: string; loginWallet: LoginWallet | null; onChange: () => void }) {
  const grant = card.keeper && card.keeper.agent === agent && Number(card.keeper.expires_ms) > Date.now() ? card.keeper : null;
  const suggested = card.offer ? units(card.offer.amountUnits) : 0;
  const offerEnds = card.offer?.expiresAt ? new Date(card.offer.expiresAt).getTime() : null;
  const [minimum, setMinimum] = useState(suggested ? suggested.toFixed(2) : "");
  const [hold, setHold] = useState(false);
  // Hold mode must last until the offer's final day, so default to a permission that covers it.
  const [days, setDays] = useState(7);
  const [payoutOn, setPayoutOn] = useState(true);
  const [payout, setPayout] = useState(loginWallet?.chainType === "solana" ? loginWallet.address : "");
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

  const minUnits = Math.round(Number(minimum) * 1e6);
  const ends = Date.now() + days * DAY;
  const tooShortForHold = hold && offerEnds !== null && ends < offerEnds - DAY;
  const valid = Number.isFinite(minUnits) && minUnits > 0 && (!payoutOn || SOLANA.test(payout.trim())) && !tooShortForHold;
  const status = card.keeperStatus;

  return (
    <section className="panel keeper" data-keeper={grant ? "on" : "off"} aria-labelledby="keeper-title">
      <h2 id="keeper-title"><Bot size={18} aria-hidden="true" /> Keeper</h2>
      {grant ? (
        <>
          <p>
            <strong>On.</strong> {grant.hold ? "Holding your card, and selling it in the last 24 hours of Collector Crypt's offer" : "Selling this card back to Collector Crypt as soon as the offer is"} {grant.hold ? "if the offer is" : ""} at least <strong>{usd(units(grant.min_price))}</strong>, until {new Date(Number(grant.expires_ms)).toLocaleString()}.
            {grant.payout ? <> Then it sends the USDC to <code>{short(grant.payout, 6)}</code> on Solana, less Mintent's fee.</> : " The money stays in this NFT's address."}
          </p>
          {status && <p className="keeper__status" data-keeper-status={status.action} role="status"><span className="keeper__pulse" aria-hidden="true" /> {status.detail} <small>{timeAgo(status.at)}</small></p>}
          <button className="btn btn--ghost" disabled={busy} onClick={() => run(() => wallet.revokeKeeper(card.token_id))}>{busy ? "Turning off…" : "Turn off the Keeper"}</button>
        </>
      ) : (
        <>
          <p className="hint">Collector Crypt's offer usually stays at about 85% of the insured value{card.offer ? ` (${usd(suggested)} now)` : ""}, and it ends on a deadline. The Keeper makes sure you don't miss it.</p>
          <fieldset className="keeper__modes">
            <legend className="sr-only">When to sell</legend>
            <label className="check"><input type="radio" name="keeper-mode" checked={!hold} onChange={() => setHold(false)} /><span><strong>Sell now</strong> while the offer meets my minimum</span></label>
            <label className="check"><input type="radio" name="keeper-mode" checked={hold} onChange={() => { setHold(true); if (offerEnds) setDays(Math.min(60, Math.max(7, Math.ceil((offerEnds - Date.now()) / DAY) + 1))); }} /><span><strong>Keep my card</strong>, and sell in the offer's last 24 hours if it still meets my minimum</span></label>
          </fieldset>
          <div className="keeper__form">
            <div className="field">
              <label htmlFor="keeper-min">Sell for at least (USDC)</label>
              <input id="keeper-min" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="field">
              <label htmlFor="keeper-days">For</label>
              <select id="keeper-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {DURATIONS.map(([label, d]) => <option key={d} value={d}>{label}</option>)}
              </select>
            </div>
          </div>
          {tooShortForHold && <p className="note">The offer ends {new Date(offerEnds!).toLocaleDateString()}, so the Keeper needs to stay on until then to sell in its last day.</p>}
          <label className="check"><input type="checkbox" checked={payoutOn} onChange={(e) => setPayoutOn(e.target.checked)} /><span>Then send the USDC to my Solana address</span></label>
          {payoutOn && (
            <div className="field">
              <label htmlFor="keeper-payout">Your Solana address</label>
              <input id="keeper-payout" value={payout} onChange={(e) => setPayout(e.target.value.trim())} autoComplete="off" spellCheck={false} />
              <p className="hint">Mintent's 1% fee (at least $0.25) comes off, as with any withdrawal. You can change the address only by turning the Keeper off and on.</p>
            </div>
          )}
          <button className="btn btn--primary" disabled={busy || !valid} onClick={() => run(() => wallet.grantKeeper(card.token_id, agent, BigInt(minUnits), ends, { payout: payoutOn ? payout.trim() : undefined, hold }))}>{busy ? "Turning on…" : "Turn on the Keeper"}</button>
        </>
      )}
      <p className="keeper__limits"><ShieldCheck size={15} aria-hidden="true" /> Enforced by the contract, not by trust: the Keeper ({short(agent, 10)}) can only sell this card back, into this NFT, at or above your minimum, and then pay only the address you chose, less Mintent's exact fee. It can't withdraw the card, send money anywhere else or transfer this NFT. Selling the NFT turns it off.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
