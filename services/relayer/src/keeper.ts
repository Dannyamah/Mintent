// The Keeper: an agent with its own NEAR account that sells a card back for its owner while Collector Crypt's offer meets the
// owner's minimum. Its decision is a simple rule, and its safety doesn't depend on it at all: the contract only lets it sign a
// sell-back of that one card, into the NFT's own address, at or above the minimum, until the permission ends.
import type { Account } from "near-api-js";
import type { MintentContract } from "@mintent/shared";
import type { CardOps } from "./ops.js";
import type { Deps } from "./deps.js";

const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

export interface KeeperDecision {
  tokenId: string;
  action: "sold" | "waiting" | "skipped";
  detail: string;
}

/** Whether the Keeper should sell now. Pure, so the rule is easy to read and test. */
export function keeperShouldSell(grant: { min_price: string; expires_ms: string } | null | undefined, offer: { available: boolean; amountUnits: number } | null, now: number): { sell: boolean; why: string } {
  if (!grant) return { sell: false, why: "no permission" };
  if (now >= Number(grant.expires_ms)) return { sell: false, why: "permission ended" };
  if (!offer?.available) return { sell: false, why: "no offer from Collector Crypt" };
  if (BigInt(Math.floor(offer.amountUnits)) < BigInt(grant.min_price)) return { sell: false, why: `offer ${offer.amountUnits} is below the minimum ${grant.min_price}` };
  return { sell: true, why: `offer ${offer.amountUnits} meets the minimum ${grant.min_price}` };
}

export function createKeeper(d: Deps & { contract: MintentContract }, ops: CardOps, agent: Account) {
  const failedAt = new Map<string, number>();
  let running = false;

  async function consider(tokenId: string): Promise<KeeperDecision> {
    const view = await d.contract.getCard(tokenId);
    const grant = view?.keeper;
    if (!view || grant?.agent !== agent.accountId) return { tokenId, action: "skipped", detail: "not ours" };
    if (view.record.status !== "Opened" || !view.record.card_mint) return { tokenId, action: "skipped", detail: view.record.status };
    if (Date.now() - (failedAt.get(tokenId) ?? 0) < RETRY_AFTER_FAILURE_MS) return { tokenId, action: "waiting", detail: "recent failure" };
    if (d.db.activeOps().some((o) => o.token_id === tokenId)) return { tokenId, action: "waiting", detail: "another action is in progress" };

    const offer = await d.cc.buybackAvailable(view.record.card_mint).catch(() => null);
    const decision = keeperShouldSell(grant, offer, Date.now());
    if (!decision.sell) return { tokenId, action: "waiting", detail: decision.why };

    try {
      const op = await ops.prepareKeeperSellback(tokenId, agent.accountId);
      const sig = await d.contract.keeperSign(agent, tokenId, Buffer.from(op.message_hex, "hex"));
      const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
      d.log(`keeper sold token ${tokenId} for its owner ${view.owner_id}: ${done.tx_sig}`);
      return { tokenId, action: "sold", detail: done.tx_sig ?? "" };
    } catch (e) {
      failedAt.set(tokenId, Date.now());
      d.log(`keeper: token ${tokenId}: ${e instanceof Error ? e.message : e}`);
      return { tokenId, action: "waiting", detail: "failed, will retry" };
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
