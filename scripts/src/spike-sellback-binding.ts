// Does Collector Crypt's buyback program reject a sell-back whose terms were tampered with? Simulates on devnet with signature
// checks off, so nothing is signed or sent. The app relies on the answer when it decides what to check before signing.
// Usage: tsx src/spike-sellback-binding.ts <token-id-holding-a-card>   (uses scripts/.demo-state.json)
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { ata, authorizeAndPayIx, CcClient, CONFIGS, coreTransferIx, createAtaIdempotentIx, loadAccount, setComputeUnitLimitIx } from "@mintent/shared";
import { createRuntime } from "@mintent/relayer";

const [tokenId] = process.argv.slice(2);
if (!tokenId) throw new Error("usage: spike-sellback-binding <token-id>");
const cfg = CONFIGS.testnet;
const state = JSON.parse(readFileSync(new URL("../.demo-state.json", import.meta.url), "utf8"));
const d = await createRuntime({ contractId: state.contract, relayer: loadAccount("testnet", state.relayer), config: cfg, log: () => undefined });
const { chain, contract } = d;
const cc = new CcClient(cfg.ccGacha, cfg.ccApi);

const view = await contract.getCard(tokenId);
if (!view?.record.card_mint) throw new Error("token holds no card");
const card = new PublicKey(await chain.cardAddress(tokenId));
const asset = new PublicKey(view.record.card_mint);
const { collection, owner } = await chain.assetOwner(view.record.card_mint);
if (owner !== card.toBase58()) throw new Error("card isn't at the token's address");
const { quote: q } = await cc.buybackQuote(card.toBase58(), view.record.card_mint);
const mint = new PublicKey(q.paymentMint);
const tokenProgram = new PublicKey(q.tokenProgram);
const attacker = new PublicKey(crypto.getRandomValues(new Uint8Array(32)));

async function simulate(name: string, change: { dest?: PublicKey; quote?: Partial<typeof q>; sellerToken?: PublicKey } = {}) {
  const quote = { ...q, ...change.quote };
  const dest = change.dest ?? new PublicKey(q.destinationOwner);
  const instructions: TransactionInstruction[] = [
    setComputeUnitLimitIx(q.computeUnitLimit ?? 250_000),
    { programId: new PublicKey(q.ed25519Instruction.programId), keys: [], data: Buffer.from(q.ed25519Instruction.data, "base64") } as unknown as TransactionInstruction,
    await createAtaIdempotentIx(chain.treasury, card, mint, tokenProgram),
    coreTransferIx(asset, collection, chain.treasury, card, dest),
    authorizeAndPayIx(quote, card, asset, change.sellerToken ?? (await ata(card, mint, tokenProgram))),
  ];
  const { blockhash } = await chain.conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: chain.treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
  const { value } = await chain.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const why = (value.logs ?? []).filter((l) => /Error|failed:|mismatch/i.test(l)).slice(-2).join(" | ").slice(0, 190);
  console.log(`${name.padEnd(40)} ${value.err ? "REJECTED" : "accepted"}  ${value.err ? why || JSON.stringify(value.err) : ""}`);
}

await simulate("unchanged (should be accepted)");
await simulate("card sent to another owner, both places", { dest: attacker, quote: { destinationOwner: attacker.toBase58() } });
await simulate("card sent elsewhere, pay ix unchanged", { dest: attacker });
await simulate("lower price", { quote: { price: String(BigInt(q.price) / 2n) } });
await simulate("money paid to another token account", { sellerToken: await ata(attacker, mint, tokenProgram) });
process.exit(0);
