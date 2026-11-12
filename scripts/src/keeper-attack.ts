// The Keeper, with its real key and a real permission, tries to go beyond it. Each attempt is a real NEAR transaction,
// and the contract must refuse it. Prints the transaction hashes so anyone can look them up.
// Usage: tsx src/keeper-attack.ts <token-id> [testnet|mainnet]
//   testnet: scripts/.demo-state.json and ~/.near-credentials/testnet/keeper.<dev>.json
//   mainnet: mintent.xinju.near, and the Keeper's function-call key (the key the hosted relayer holds), never its full-access key
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPairSigner } from "near-api-js";
import { nearProvider, ata, authorizeAndPayIx, CcClient, CONFIGS, coreTransferIx, createAtaIdempotentIx, loadAccount, setComputeUnitLimitIx, transferCheckedIx } from "@mintent/shared";
import { createRuntime } from "@mintent/relayer";

const [tokenId, network = "testnet"] = process.argv.slice(2);
if (!tokenId || (network !== "testnet" && network !== "mainnet")) throw new Error("usage: keeper-attack <token-id> [testnet|mainnet]");
const cfg = { ...CONFIGS[network], ...(network === "mainnet" && process.env.SOLANA_RPC_URL ? { solanaRpc: process.env.SOLANA_RPC_URL } : {}) };
const state = network === "mainnet"
  ? { contract: "mintent.xinju.near", relayer: "relayer.xinju.near" }
  : (JSON.parse(readFileSync(new URL("../.demo-state.json", import.meta.url), "utf8")) as { contract: string; relayer: string });
const d = await createRuntime({ contractId: state.contract, relayer: loadAccount(network, state.relayer), config: cfg, log: () => undefined });
const keeperId = network === "mainnet" ? "keeper.xinju.near" : "keeper.mintent-dev-mw21w9ki.testnet";
const fcKey = JSON.parse(readFileSync(join(homedir(), ".near-credentials", network, `${keeperId}.function-call.json`), "utf8")) as { private_key: Parameters<typeof KeyPairSigner.fromSecretKey>[0] };
const keeper = new Account(keeperId, nearProvider(network), KeyPairSigner.fromSecretKey(fcKey.private_key));
const cc = new CcClient(cfg.ccGacha, cfg.ccApi);

const view = await d.contract.getCard(tokenId);
if (!view?.keeper || view.keeper.agent !== keeper.accountId || !view.record.card_mint) throw new Error("token has no live permission for this Keeper");
const card = new PublicKey(await d.chain.cardAddress(tokenId));
const asset = new PublicKey(view.record.card_mint);
const { collection } = await d.chain.assetOwner(view.record.card_mint);
const attacker = new PublicKey(crypto.getRandomValues(new Uint8Array(32)));
const { quote: q } = await cc.buybackQuote(card.toBase58(), view.record.card_mint);
const mint = new PublicKey(q.paymentMint);
const tokenProgram = new PublicKey(q.tokenProgram);
const ed = { programId: new PublicKey(q.ed25519Instruction.programId), keys: [], data: Buffer.from(q.ed25519Instruction.data, "base64") } as unknown as TransactionInstruction;
console.log(`offer ${q.price}, owner's minimum ${view.keeper.min_price}`);

async function attempt(name: string, instructions: TransactionInstruction[]) {
  const tx = await d.chain.buildNonceTx(1, instructions);
  try {
    await keeper.callFunction({ contractId: state.contract, methodName: "keeper_sign", args: { token_id: tokenId, payload_hex: Buffer.from(tx.message.serialize()).toString("hex") }, deposit: 0n, gas: 50_000_000_000_000n });
    console.log(`SIGNED  ${name}   <- the contract should have refused this`);
  } catch (e) {
    const err = e as { message?: string; transactionResult?: { transaction?: { hash?: string } } };
    const why = String(err.message ?? e).match(/panicked: ([^\n"]+)/)?.[1] ?? String(err.message ?? e).slice(0, 120);
    console.log(`REFUSED ${name}: "${why}"  tx ${err.transactionResult?.transaction?.hash ?? "?"}`);
  }
}

await attempt("withdraw the card to the Keeper's own address", [coreTransferIx(asset, collection, d.chain.treasury, card, attacker)]);
await attempt("sell back below the owner's minimum", [
  setComputeUnitLimitIx(250_000), ed, await createAtaIdempotentIx(d.chain.treasury, card, mint, tokenProgram),
  coreTransferIx(asset, collection, d.chain.treasury, card, new PublicKey(q.destinationOwner)), authorizeAndPayIx(q, card, asset, await ata(card, mint, tokenProgram)),
]);
await attempt("sell back with the money paid to the Keeper", [
  setComputeUnitLimitIx(250_000), ed, await createAtaIdempotentIx(d.chain.treasury, attacker, mint, tokenProgram),
  coreTransferIx(asset, collection, d.chain.treasury, card, new PublicKey(q.destinationOwner)), authorizeAndPayIx(q, card, asset, await ata(attacker, mint, tokenProgram)),
]);
// Payout attacks, if the owner allowed a payout: pay the Keeper instead, or take a bigger fee than Mintent's.
async function payoutAttempt(name: string, to: PublicKey, net: bigint, fee: bigint) {
  const tx = await d.chain.buildNonceTx(1, [
    await createAtaIdempotentIx(d.chain.treasury, to, mint, tokenProgram),
    transferCheckedIx(await ata(card, mint, tokenProgram), mint, await ata(to, mint, tokenProgram), card, net, 6),
    await createAtaIdempotentIx(d.chain.treasury, d.chain.treasury, mint, tokenProgram),
    transferCheckedIx(await ata(card, mint, tokenProgram), mint, await ata(d.chain.treasury, mint, tokenProgram), card, fee, 6),
  ]);
  try {
    await keeper.callFunction({ contractId: state.contract, methodName: "keeper_payout", args: { token_id: tokenId, payload_hex: Buffer.from(tx.message.serialize()).toString("hex") }, deposit: 0n, gas: 50_000_000_000_000n });
    console.log(`SIGNED  ${name}   <- the contract should have refused this`);
  } catch (e) {
    const err = e as { message?: string; transactionResult?: { transaction?: { hash?: string } } };
    const why = String(err.message ?? e).match(/panicked: ([^\n"]+)/)?.[1] ?? String(err.message ?? e).slice(0, 120);
    console.log(`REFUSED ${name}: "${why}"  tx ${err.transactionResult?.transaction?.hash ?? "?"}`);
  }
}
if (view.keeper.payout) {
  await payoutAttempt("pay out to the Keeper instead of the owner", attacker, 1_000_000n, 250_000n);
  await payoutAttempt("pay the owner but take a bigger fee", new PublicKey(view.keeper.payout), 1_000_000n, 300_000n);
}
const after = await d.contract.getCard(tokenId);
console.log(`after: ${after?.record.status}, card still at the NFT's address: ${(await d.chain.assetOwner(view.record.card_mint)).owner === card.toBase58()}`);
process.exit(0);
