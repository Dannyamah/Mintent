// The Keeper: an agent with its own NEAR account that sells a card back for its owner while Collector Crypt's offer meets the
// owner's minimum, either straight away or only near the end of the offer, and then, if the owner chose an address, pays the
// USDC out to it. Its decisions are simple rules, and its safety doesn't depend on them: the contract only lets it sign a
// sell-back of that one card into the NFT's own address at or above the minimum, and a payout to the owner's chosen address
// less Mintent's exact fee, until the permission ends.
import type { Account } from "near-api-js";
import { afterExitFee, type MintentContract } from "@mintent/shared";
import type { CardOps } from "./ops.js";
import type { Deps } from "./deps.js";

/** "Wed 9 Dec, 15:33 UTC": readable in the Keeper's notes, and the same for every viewer. */
const when = (ms: number) => {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
};

const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
/** In hold mode, the Keeper sells in the offer's last day. */
export const HOLD_WINDOW_MS = 24 * 60 * 60_000;

export interface KeeperDecision {
  tokenId: string;
  action: "sold" | "paid" | "waiting" | "skipped";
  detail: string;
}

interface Grant {
  min_price: string;
  expires_ms: string;
  hold?: boolean;
  payout?: string | null;
}

/** Identifies one permission's terms. A status is shown only while the permission it was written under is the live one. */
export const grantKey = (g: Grant) => [g.min_price, g.expires_ms, g.hold ? "hold" : "now", g.payout ?? ""].join("|");

/** The status to show the owner: hidden when it was written under an earlier permission than the live one. */
export function currentKeeperStatus<S extends { grant_key: string | null }>(status: S | undefined, live: Grant | null | undefined): Omit<S, "grant_key"> | null {
  if (!status) return null;
  const { grant_key, ...rest } = status;
  if (live && grant_key && grant_key !== grantKey(live)) return null;
  return rest;
}

/** Whether the Keeper should sell now, and why. Pure, so the rule is easy to read and test. */
export function keeperShouldSell(grant: Grant | null | undefined, offer: { available: boolean; amountUnits: number; expiresAt?: string | null } | null, now: number): { sell: boolean; why: string } {
  const dollars = (u: number | string) => `$${(Number(u) / 1e6).toFixed(2)}`;
  if (!grant) return { sell: false, why: "No permission." };
  if (now >= Number(grant.expires_ms)) return { sell: false, why: "Your permission has ended." };
  if (!offer?.available) return { sell: false, why: "Collector Crypt isn't offering to buy this card right now." };
  if (BigInt(Math.floor(offer.amountUnits)) < BigInt(grant.min_price)) return { sell: false, why: `Waiting: the offer is ${dollars(offer.amountUnits)}, below your ${dollars(grant.min_price)} minimum.` };
  if (grant.hold && offer.expiresAt) {
    const left = new Date(offer.expiresAt).getTime() - now;
    if (left > HOLD_WINDOW_MS) return { sell: false, why: `Holding your card: the ${dollars(offer.amountUnits)} offer meets your minimum, and I'll sell in its last 24 hours, from ${when(new Date(offer.expiresAt).getTime() - HOLD_WINDOW_MS)}.` };
  }
  return { sell: true, why: `Selling: the offer is ${dollars(offer.amountUnits)}, at or above your ${dollars(grant.min_price)} minimum.` };
}

export function createKeeper(d: Deps & { contract: MintentContract }, ops: CardOps, agent: Account) {
  const failedAt = new Map<string, number>();
  let running = false;
  const note = (tokenId: string, decision: KeeperDecision, grant: Grant): KeeperDecision => {
    d.db.setKeeperStatus(tokenId, decision.action, decision.detail, grantKey(grant));
    return decision;
  };

  async function consider(tokenId: string): Promise<KeeperDecision> {
    const view = await d.contract.getCard(tokenId);
    const grant = view?.keeper;
    if (!view || grant?.agent !== agent.accountId) return { tokenId, action: "skipped", detail: "not ours" };
    if (Date.now() >= Number(grant.expires_ms)) return note(tokenId, { tokenId, action: "skipped", detail: "Your permission has ended." }, grant);
    if (Date.now() - (failedAt.get(tokenId) ?? 0) < RETRY_AFTER_FAILURE_MS) return { tokenId, action: "waiting", detail: "recent failure" };
    if (d.db.activeOps().some((o) => o.token_id === tokenId)) return { tokenId, action: "waiting", detail: "another action is in progress" };

    try {
      if (view.record.status === "Opened" && view.record.card_mint) {
        const offer = await d.cc.buybackAvailable(view.record.card_mint).catch(() => null);
        const decision = keeperShouldSell(grant, offer, Date.now());
        if (!decision.sell) return note(tokenId, { tokenId, action: "waiting", detail: decision.why }, grant);
        note(tokenId, { tokenId, action: "waiting", detail: decision.why }, grant);
        const op = await ops.prepareKeeperSellback(tokenId, agent.accountId);
        const sig = await d.contract.keeperSign(agent, tokenId, Buffer.from(op.message_hex, "hex"));
        const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
        d.log(`keeper sold token ${tokenId} for its owner ${view.owner_id}: ${done.tx_sig}`);
        return note(tokenId, { tokenId, action: "sold", detail: `Sold back for $${(Number(JSON.parse(op.detail).price) / 1e6).toFixed(2)}.${grant.payout ? " Paying you out next." : ""}` }, grant);
      }

      if (view.record.status === "Released" && grant.payout) {
        const card = await d.chain.cardAddress(tokenId);
        const held = await d.chain.tokenBalance(card, d.config.ccPaymentMint);
        if (!afterExitFee(held)) return note(tokenId, { tokenId, action: "skipped", detail: held > 0n ? "Too little USDC to cover the fee." : "Nothing left to pay out." }, grant);
        const op = await ops.prepareKeeperPayout(tokenId, agent.accountId);
        const sig = await d.contract.keeperPayout(agent, tokenId, Buffer.from(op.message_hex, "hex"));
        const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
        const net = Number(JSON.parse(op.detail).net) / 1e6;
        d.log(`keeper paid out token ${tokenId} to ${grant.payout}: ${done.tx_sig}`);
        return note(tokenId, { tokenId, action: "paid", detail: `Sent you $${net.toFixed(2)} USDC on Solana.` }, grant);
      }
      return { tokenId, action: "skipped", detail: view.record.status };
    } catch (e) {
      failedAt.set(tokenId, Date.now());
      d.log(`keeper: token ${tokenId}: ${e instanceof Error ? e.message : e}`);
      return note(tokenId, { tokenId, action: "waiting", detail: "Something failed. I'll try again in 10 minutes." }, grant);
    }
  }

  /** Look at every card this relayer delivered, and act on the ones whose owners gave this Keeper permission. */
  return async function tick(): Promise<KeeperDecision[]> {
    if (running) return [];
    running = true;
    try {
      const tokens = [...new Set(d.db.orders().filter((o) => o.state === "complete" && o.token_id).map((o) => o.token_id!))];
      const out: KeeperDecision[] = [];
      for (const id of tokens) out.push(await consider(id).catch((e) => ({ tokenId: id, action: "waiting" as const, detail: String(e) })));
      return out;
    } finally {
      running = false;
    }
  };
}
