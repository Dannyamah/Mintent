// Mainnet, no money: ask Collector Crypt for a real purchase transaction and run our safety check on it. Nothing is signed or sent,
// and an unpaid pack simply expires. Answers what only mainnet can: does a real purchase pass assertSafePackTx?
// Usage: tsx src/mainnet-pack-check.ts <contract.near> [pack-code]
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { assertSafePackTx, CcClient, CONFIGS, deriveSolanaAddress } from "@mintent/shared";

const [contract, packArg] = process.argv.slice(2);
if (!contract?.endsWith(".near")) throw new Error("usage: mainnet-pack-check <contract.near> [pack-code]");
const cfg = CONFIGS.mainnet;
const pack = packArg ?? cfg.defaultPack;
const cc = new CcClient(cfg.ccGacha, cfg.ccApi);

const treasury = new PublicKey(await deriveSolanaAddress("mainnet", contract, "treasury"));
const card = await deriveSolanaAddress("mainnet", contract, "card/0");
console.log({ treasury: treasury.toBase58(), firstCardAddress: card });

const machine = await cc.machine(pack);
const price = BigInt(Math.round(machine.price)) * 1_000_000n;
console.log({ pack: machine.code, price: machine.price, expectedValue: machine.ev, buybackPct: machine.instantBuyback, odds: machine.odds });

const { memo, transaction } = await cc.generatePack(treasury.toBase58(), pack, card);
const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
const keys = tx.message.staticAccountKeys;
console.log({ memo, version: tx.version, feePayer: keys[0].toBase58(), feePayerIsTreasury: keys[0].equals(treasury), lookupTables: "addressTableLookups" in tx.message ? (tx.message.addressTableLookups as unknown[]).length : 0, signaturesNeeded: tx.message.header.numRequiredSignatures });
console.log("programs:", tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58() ?? `lookup #${ix.programIdIndex}`));
const blockhashValidForAbout = 60;
console.log(`blockhash ${tx.message.recentBlockhash}; a real purchase must sign and send within about ${blockhashValidForAbout} s`);

try {
  assertSafePackTx(tx, treasury, new PublicKey(cfg.ccPaymentMint), price);
  console.log("RESULT: assertSafePackTx PASSED on a real mainnet purchase transaction. Nothing was signed or sent.");
} catch (e) {
  console.log(`RESULT: assertSafePackTx REFUSED it: ${e instanceof Error ? e.message : e}. Nothing was signed or sent.`);
  process.exit(1);
}
process.exit(0);
