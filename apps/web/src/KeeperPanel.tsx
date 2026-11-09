// The Keeper: let an agent sell this card back for you while Collector Crypt's offer meets your minimum. The contract limits it to
// exactly that: a sell-back of this card, into this NFT's own address, at or above your minimum, until the end you choose.
import { Bot, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { short, units, usd, type Card } from "./api";
import { refusal, type Wallet } from "./wallet";

const DURATIONS: [string, number][] = [["1 day", 1], ["7 days", 7], ["30 days", 30]];
const DAY = 24 * 60 * 60 * 1000;

export function KeeperPanel({ card, wallet, agent, onChange }: { card: Card; wallet: Wallet; agent: string; onChange: () => void }) {
  const grant = card.keeper && card.keeper.agent === agent && Number(card.keeper.expires_ms) > Date.now() ? card.keeper : null;
  const suggested = card.offer ? units(card.offer.amountUnits) : 0;
  const [minimum, setMinimum] = useState(suggested ? suggested.toFixed(2) : "");
  const [days, setDays] = useState(7);
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
  const valid = Number.isFinite(minUnits) && minUnits > 0;

  return (
    <section className="panel keeper" data-keeper={grant ? "on" : "off"} aria-labelledby="keeper-title">
      <h2 id="keeper-title"><Bot size={18} aria-hidden="true" /> Keeper</h2>
      {grant ? (
        <>
          <p>
            <strong>On.</strong> The Keeper sells this card back to Collector Crypt as soon as the offer is at least <strong>{usd(units(grant.min_price))}</strong>, until {new Date(Number(grant.expires_ms)).toLocaleString()}. The money lands in this NFT's address.
          </p>
          <button className="btn btn--ghost" disabled={busy} onClick={() => run(() => wallet.revokeKeeper(card.token_id))}>{busy ? "Turning off…" : "Turn off the Keeper"}</button>
        </>
      ) : (
        <>
          <p className="hint">Sell-back offers don't last. The Keeper sells this card for you while Collector Crypt's offer meets your minimum{card.offer ? `, which is ${usd(suggested)} now` : ""}.</p>
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
          <button className="btn btn--primary" disabled={busy || !valid} onClick={() => run(() => wallet.grantKeeper(card.token_id, agent, BigInt(minUnits), Date.now() + days * DAY))}>{busy ? "Turning on…" : "Turn on the Keeper"}</button>
        </>
      )}
      <p className="keeper__limits"><ShieldCheck size={15} aria-hidden="true" /> Enforced by the contract, not by trust: the Keeper ({short(agent, 10)}) can only sell this card back, into this NFT, at or above your minimum. It can't withdraw the card, move your USDC or transfer this NFT. Selling the NFT turns it off.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
