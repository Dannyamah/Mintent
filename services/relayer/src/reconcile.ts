// The contract can't see Solana. This compares what NEAR records with who really holds each card, and fixes the
// record where the answer is unambiguous (D-014).
import type { Deps } from "./deps.js";

export interface ReconcileFinding {
  tokenId: string;
  action: "released" | "exit_cleared" | "op_expired" | "op_landed" | "drift";
  detail: string;
}

export async function reconcile(d: Deps): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = [];
  const now = Date.now();

  // Operations with a broadcast transaction, or past their time.
  for (const op of d.db.activeOps()) {
    if (op.tx_sig) {
      const st = await d.chain.signatureStatus(op.tx_sig);
      if (st === "confirmed") {
        d.db.updateOp(op.id, { state: "sent" });
        if (op.moves_card) await d.contract.recordRelease(op.token_id, op.kind === "sellback" ? "bought_back" : "withdrawn");
        findings.push({ tokenId: op.token_id, action: "op_landed", detail: op.tx_sig });
      } else if (st === "failed") {
        d.db.updateOp(op.id, { state: "failed", error: "transaction failed on chain" });
      }
    } else if (op.expires_at < now) {
      d.db.updateOp(op.id, { state: "expired" });
      findings.push({ tokenId: op.token_id, action: "op_expired", detail: op.kind });
    }
  }

  const active = new Set(d.db.activeOps().map((o) => o.token_id));
  for (const o of d.db.orders()) {
    if (!o.token_id || !o.card_mint || !o.card_address) continue;
    const view = await d.contract.getCard(o.token_id);
    if (!view) continue;
    const { owner } = await d.chain.assetOwner(o.card_mint);
    const atAddress = owner === o.card_address;
    const status = view.record.status;
    if ((status === "Opened" || status === "Exiting") && !atAddress) {
      await d.contract.recordRelease(o.token_id, "reconciled");
      findings.push({ tokenId: o.token_id, action: "released", detail: `card now held by ${owner}` });
    } else if (status === "Exiting" && atAddress && !active.has(o.token_id)) {
      // Safe: the exit needed the treasury's co-signature, and no live operation will give it.
      await d.contract.recordExitFailed(o.token_id);
      findings.push({ tokenId: o.token_id, action: "exit_cleared", detail: "exit never landed" });
    } else if (status === "Released" && atAddress) {
      findings.push({ tokenId: o.token_id, action: "drift", detail: "NEAR says released but the card is still at the token's address" });
    }
  }
  return findings;
}
