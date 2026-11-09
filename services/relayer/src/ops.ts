// Owner-initiated card operations: sell back, withdraw the card, withdraw proceeds.
// Flow: prepare (relayer builds and checks the message) -> the owner calls sign_for_card with their own key ->
// finalize (relayer verifies, co-signs as fee payer and broadcasts).
// The relayer can't move a card without the owner, and the owner can't land a nonce transaction without the relayer.
import { randomUUID } from "node:crypto";
import { PublicKey, VersionedTransaction, VersionedMessage, type TransactionInstruction } from "@solana/web3.js";
import { afterExitFee, ata, authorizeAndPayIx, coreTransferIx, createAtaIdempotentIx, setComputeUnitLimitIx, transferCheckedIx, verifyEd25519 } from "@mintent/shared";
import { looksLikeAddress, quoteErrorForCustomer, TERMINAL_STATES, type SwapState } from "@mintent/checkout";
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

  /** Send `total` USDC from the NFT: the owner's share to `to`, Mintent's fee to the treasury, in one transaction. */
  private async usdcExit(card: PublicKey, to: PublicKey, total: bigint) {
    const { chain, config } = this.d;
    const split = afterExitFee(total);
    if (!split) throw Object.assign(new Error("This amount is too small to cover the $0.25 minimum fee."), { status: 400 });
    const mint = new PublicKey(config.ccPaymentMint);
    const from = await ata(card, mint);
    const instructions = [
      await createAtaIdempotentIx(chain.treasury, to, mint),
      transferCheckedIx(from, mint, await ata(to, mint), card, split.net, 6),
      await createAtaIdempotentIx(chain.treasury, chain.treasury, mint),
      transferCheckedIx(from, mint, await ata(chain.treasury, mint), card, split.fee, 6),
    ];
    return { instructions, ...split };
  }

  async prepareWithdrawProceeds(tokenId: string, actor: string, destination: string): Promise<Op> {
    const { chain, config } = this.d;
    await this.assertOwner(tokenId, actor);
    const card = new PublicKey(await chain.cardAddress(tokenId));
    const amount = await chain.tokenBalance(card.toBase58(), config.ccPaymentMint);
    if (amount === 0n) throw new Error("this token holds no proceeds");
    const exit = await this.usdcExit(card, new PublicKey(destination), amount);
    return this.create("withdraw_proceeds", tokenId, actor, exit.instructions, { destination, amount: amount.toString(), fee: exit.fee.toString(), net: exit.net.toString(), mint: config.ccPaymentMint }, false);
  }

  /**
   * Turn the USDC this NFT holds into any asset on any chain. Mainnet: the NFT's address pays 1Click's deposit address
   * directly, and a refund comes back to the NFT's address, so it stays with whoever owns the NFT.
   * Testnet: sell-back money is Collector Crypt's USDC-Dev, which Tidepool doesn't take. It goes to the treasury, and the
   * treasury funds the deposit in Tidepool's test USDC (advanceCashOuts).
   */
  async prepareCashOut(tokenId: string, actor: string, destinationAsset: string, recipient: string): Promise<Op> {
    const { chain, config, checkout } = this.d;
    await this.assertOwner(tokenId, actor);
    const asset = (await checkout.tokens()).find((t) => t.assetId === destinationAsset);
    if (!asset) throw Object.assign(new Error("that asset can't be paid out"), { status: 400 });
    if (!looksLikeAddress(asset.blockchain, recipient)) throw Object.assign(new Error(`That doesn't look like a ${asset.blockchain} address.`), { status: 400 });
    const card = new PublicKey(await chain.cardAddress(tokenId));
    const amount = await chain.tokenBalance(card.toBase58(), config.ccPaymentMint);
    if (amount === 0n) throw Object.assign(new Error("this token holds no proceeds"), { status: 400 });
    const split = afterExitFee(amount);
    if (!split) throw Object.assign(new Error("This amount is too small to cover the $0.25 minimum fee."), { status: 400 });

    const isTest = config.network === "testnet";
    if (isTest && (await chain.tokenBalance(chain.treasury.toBase58(), config.checkoutMint)) < split.net) throw Object.assign(new Error("The test treasury can't cover this cash-out right now."), { status: 503 });
    const quote = await checkout.payoutQuote({ originAsset: config.checkoutDestinationAsset, destinationAsset, amountIn: split.net.toString(), recipient, refundTo: isTest ? chain.treasury.toBase58() : card.toBase58() }).catch((e) => {
      this.d.log(`cash-out quote failed for ${destinationAsset}: ${e}`);
      throw Object.assign(new Error(quoteErrorForCustomer(e)), { status: 502 });
    });
    if (quote.depositMemo) throw new Error("1Click asked for a memo, which a Solana deposit shouldn't need");

    const payTo = isTest ? chain.treasury : new PublicKey(quote.depositAddress);
    const exit = await this.usdcExit(card, payTo, amount);
    return this.create(
      "cash_out",
      tokenId,
      actor,
      exit.instructions,
      { amount: amount.toString(), fee: exit.fee.toString(), net: exit.net.toString(), mint: config.ccPaymentMint, destinationAsset, symbol: asset.symbol, chain: asset.blockchain, decimals: asset.decimals, recipient, depositAddress: quote.depositAddress, amountOut: quote.amountOut, amountOutFormatted: quote.amountOutFormatted, minAmountOut: quote.minAmountOut, deadline: quote.deadline, timeEstimateSeconds: quote.timeEstimateSeconds, quote: quote.raw },
      false,
    );
  }

  /** Move landed cash-outs along. Safe to run repeatedly: each step is recorded, and a step that fails runs again next tick. */
  async advanceCashOuts(): Promise<void> {
    const { db, checkout, log } = this.d;
    for (const op of db.openCashOuts()) {
      try {
        const detail = JSON.parse(op.detail) as { depositAddress: string; amount: string; net?: string };
        let deposit = op.swap_deposit_tx;
        if (!deposit) {
          deposit = this.d.fundTestCashOut ? await this.d.fundTestCashOut(detail.depositAddress, BigInt(detail.net ?? detail.amount)) : op.tx_sig!;
          db.updateOp(op.id, { swap_deposit_tx: deposit, swap_status: "PENDING_DEPOSIT" });
          // Only speeds up detection, so a failure here doesn't matter.
          await checkout.submitDeposit(deposit, detail.depositAddress).catch(() => undefined);
        }
        const status = await checkout.status(detail.depositAddress);
        if (status.status === op.swap_status) continue;
        const dest = status.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null;
        db.updateOp(op.id, { swap_status: status.status, swap_amount_out: status.swapDetails?.amountOut ?? null, swap_dest_tx: dest });
        if (TERMINAL_STATES.includes(status.status as SwapState)) log(`op ${op.id} cash_out ${status.status}: ${dest ?? status.swapDetails?.refundReason ?? ""}`);
      } catch (e) {
        log(`op ${op.id} cash_out: ${e instanceof Error ? e.message : e}`);
      }
    }
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
