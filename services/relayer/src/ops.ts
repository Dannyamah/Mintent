// Owner-initiated card operations: sell back, withdraw the card, withdraw proceeds.
// Flow: prepare (relayer builds and checks the message) -> the owner calls sign_for_card with their own key ->
// finalize (relayer verifies, co-signs as fee payer and broadcasts).
// The relayer can't move a card without the owner, and the owner can't land a nonce transaction without the relayer.
import { randomUUID } from "node:crypto";
import { PublicKey, VersionedTransaction, VersionedMessage, type TransactionInstruction } from "@solana/web3.js";
import { ata, authorizeAndPayIx, coreTransferIx, createAtaIdempotentIx, setComputeUnitLimitIx, transferCheckedIx, verifyEd25519 } from "@mintent/shared";
import type { Op, OpKind } from "./db.js";
import type { Deps } from "./deps.js";

const OP_TTL_MS = 9 * 60_000; // CC quotes live 10 minutes

export class CardOps {
  constructor(private d: Deps) {}

  private async assertOwner(tokenId: string, actor: string) {
    const card = await this.d.contract.getCard(tokenId);
    if (!card) throw new Error(`unknown token ${tokenId}`);
    if (card.owner_id !== actor) throw new Error(`${actor} is not the owner of token ${tokenId}`);
    return card;
  }

  /** Reserve a durable nonce account for one operation at a time. */
  private reserveNonce(): number {
    const now = Date.now();
    const busy = new Set(this.d.db.activeOps().filter((o) => o.expires_at > now).map((o) => o.nonce_index));
    for (let i = 1; i <= this.d.config.nonceAccounts; i++) if (!busy.has(i)) return i;
    throw new Error("all signing slots are busy; try again in a moment");
  }

  private async create(kind: OpKind, tokenId: string, actor: string, instructions: TransactionInstruction[], detail: Record<string, unknown>, expectMovesCard: boolean): Promise<Op> {
    const { chain, contract, db, sponsor, log } = this.d;
    const nonceIndex = this.reserveNonce();
    // Whoever owns a token can always act on it, even someone given the NFT who has never held NEAR.
    await sponsor.ensureFunded(actor).catch((e) => log(`sponsor failed for ${actor}: ${e}`));
    const tx = await chain.buildNonceTx(nonceIndex, instructions);
    const hex = Buffer.from(tx.message.serialize()).toString("hex");
    // Dry-run the contract's policy now, so the owner is never asked to sign something it will refuse.
    const check = await contract.checkCardMessage(hex);
    if (check.moves_card !== expectMovesCard || !check.uses_durable_nonce) throw new Error(`policy classified the message unexpectedly: ${JSON.stringify(check)}`);
    return db.insertOp({ id: randomUUID(), token_id: tokenId, kind, actor, card_address: await chain.cardAddress(tokenId), message_hex: hex, nonce_index: nonceIndex, moves_card: expectMovesCard ? 1 : 0, detail: JSON.stringify(detail), expires_at: Date.now() + OP_TTL_MS });
  }

  async prepareSellback(tokenId: string, actor: string): Promise<Op> {
    const { chain, cc } = this.d;
    const view = await this.assertOwner(tokenId, actor);
    if (view.record.status !== "Opened" || !view.record.card_mint) throw new Error(`token ${tokenId} holds no card (${view.record.status})`);
    const card = new PublicKey(await chain.cardAddress(tokenId));
    const asset = new PublicKey(view.record.card_mint);
    const { owner, collection } = await chain.assetOwner(view.record.card_mint);
    if (owner !== card.toBase58()) throw new Error(`card is not at the token's address (owner ${owner})`);
    const { quote: q } = await cc.buybackQuote(card.toBase58(), view.record.card_mint);
    if (q.standard !== "core") throw new Error(`card standard ${q.standard} is not supported`);
    const tokenProgram = new PublicKey(q.tokenProgram);
    const mint = new PublicKey(q.paymentMint);
    const instructions = [
      setComputeUnitLimitIx(q.computeUnitLimit ?? 250_000),
      { programId: new PublicKey(q.ed25519Instruction.programId), keys: [], data: Buffer.from(q.ed25519Instruction.data, "base64") } as unknown as TransactionInstruction,
      await createAtaIdempotentIx(chain.treasury, card, mint, tokenProgram),
      coreTransferIx(asset, collection, chain.treasury, card, new PublicKey(q.destinationOwner)),
      authorizeAndPayIx(q, card, asset, await ata(card, mint, tokenProgram)),
    ];
    return this.create("sellback", tokenId, actor, instructions, { price: q.price, mint: q.paymentMint, expiresAt: q.expiresAt }, true);
  }

  async prepareWithdrawCard(tokenId: string, actor: string, destination: string): Promise<Op> {
    const { chain } = this.d;
    const view = await this.assertOwner(tokenId, actor);
    if (view.record.status !== "Opened" || !view.record.card_mint) throw new Error(`token ${tokenId} holds no card (${view.record.status})`);
    const card = new PublicKey(await chain.cardAddress(tokenId));
    const { owner, collection } = await chain.assetOwner(view.record.card_mint);
    if (owner !== card.toBase58()) throw new Error(`card is not at the token's address (owner ${owner})`);
    const dest = new PublicKey(destination);
    return this.create("withdraw_card", tokenId, actor, [coreTransferIx(new PublicKey(view.record.card_mint), collection, chain.treasury, card, dest)], { destination }, true);
  }

  async prepareWithdrawProceeds(tokenId: string, actor: string, destination: string): Promise<Op> {
    const { chain, config } = this.d;
    await this.assertOwner(tokenId, actor);
    const card = new PublicKey(await chain.cardAddress(tokenId));
    const mint = new PublicKey(config.ccPaymentMint);
    const amount = await chain.tokenBalance(card.toBase58(), config.ccPaymentMint);
    if (amount === 0n) throw new Error("this token holds no proceeds");
    const dest = new PublicKey(destination);
    return this.create(
      "withdraw_proceeds",
      tokenId,
      actor,
      [await createAtaIdempotentIx(chain.treasury, dest, mint), transferCheckedIx(await ata(card, mint), mint, await ata(dest, mint), card, amount, 6)],
      { destination, amount: amount.toString(), mint: config.ccPaymentMint },
      false,
    );
  }

  /** The owner has signed. Check everything again, co-sign, broadcast. */
  async finalize(opId: string, cardSignatureHex: string): Promise<Op> {
    const { db, contract, chain, log } = this.d;
    const op = db.op(opId);
    if (!op) throw new Error(`unknown operation ${opId}`);
    if (op.state !== "prepared") throw new Error(`operation is ${op.state}`);
    if (Date.now() > op.expires_at) {
      db.updateOp(opId, { state: "expired" });
      throw new Error("operation expired; start again");
    }
    const message = Buffer.from(op.message_hex, "hex");
    const cardSig = Buffer.from(cardSignatureHex, "hex");
    if (cardSig.length !== 64 || !verifyEd25519(op.card_address, message, cardSig)) throw new Error("card signature does not verify");
    // Ownership may have changed since prepare. The relayer's signature is the second lock on a nonce transaction.
    const view = await contract.getCard(op.token_id);
    if (view?.owner_id !== op.actor) {
      db.updateOp(opId, { state: "failed", error: "owner changed" });
      throw new Error("token owner changed; refusing to co-sign");
    }
    const treasurySig = await contract.signForTreasury(message);
    const tx = new VersionedTransaction(VersionedMessage.deserialize(message));
    tx.addSignature(chain.treasury, treasurySig);
    tx.addSignature(new PublicKey(op.card_address), cardSig);

    let sent: string;
    try {
      sent = await chain.send(tx);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      db.updateOp(opId, { state: "failed", error: error.slice(0, 500) });
      if (op.moves_card) await this.clearExit(op);
      throw e;
    }
    db.updateOp(opId, { tx_sig: sent });
    for (let i = 0; i < 60; i++) {
      const st = await chain.signatureStatus(sent);
      if (st === "failed") {
        db.updateOp(opId, { state: "failed", error: "transaction failed on chain" });
        if (op.moves_card) await this.clearExit(op);
        throw new Error(`transaction ${sent} failed on chain`);
      }
      if (st === "confirmed") {
        if (op.moves_card) await contract.recordRelease(op.token_id, op.kind === "sellback" ? "bought_back" : "withdrawn");
        log(`op ${opId} ${op.kind} landed: ${sent}`);
        return db.updateOp(opId, { state: "sent" });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return db.op(opId)!; // left "prepared" with tx_sig set: the reconciler resolves it
  }

  private async clearExit(op: Op): Promise<void> {
    const view = await this.d.contract.getCard(op.token_id);
    if (view?.record.status === "Exiting") await this.d.contract.recordExitFailed(op.token_id);
  }
}
