# Mintent

Real graded trading cards, paid for from any chain, owned as NEAR NFTs.

Each pack you buy becomes a NEP-171 token on NEAR. The token controls its own Solana address through NEAR Chain Signatures, and that address holds the real card, which is backed by a physical graded slab in Collector Crypt's vault. **Transfer the NFT on NEAR and control of the card moves with it, with no Solana transaction.** Whoever holds the NFT can sell the card back or withdraw it, and the previous owner can't.

Built at NEAR HACKATHON for the `nfts` track ("NFTs that do something"): each NFT here is an account that holds an asset and money.

> **Status, 9 Nov 2026: everything below has run on public test networks with no real money. Nothing has run on mainnet yet.** See [Limits](#limits).

## Check it in 2 minutes, with no accounts or keys

Needs Node 22.22 or newer and pnpm.

```bash
pnpm install
pnpm verify:pull mintent-con-mw7mmwr5.testnet 0   # sold back by its new owner
pnpm verify:pull mintent-con-mw7mmwr5.testnet 1   # withdrawn to the owner's own wallet
```

**You should see** `ALL CHECKS PASSED` for each. These commands read only public data from NEAR RPC, Solana RPC and Collector Crypt's verifier, and trust nothing from our servers. They check that:

- the NFT's owner matches the card record
- the card's address derives from the contract through the NEAR MPC network
- the card is where NEAR says it is on Solana
- the pack's random draw has a valid VRF proof

```bash
pnpm --filter @mintent/checkout test   # 7 pass: checkout
pnpm --filter @mintent/relayer test    # 44 pass: order pipeline, sell-back, recovery
pnpm test:web                          # 3 pass: Privy signer gives the same signature as a local key
pnpm test:contracts                    # contract, including the attack tests; needs Rust and cargo-near
```

Every step of the real runs, with transaction links, is in [docs/EVIDENCE.md](docs/EVIDENCE.md).

## What to look for

| Claim | How to check |
| --- | --- |
| The NFT controls a real card | Run `verify:pull`, or follow the [card asset](https://explorer.solana.com/address/FR2ckzK3V8TKYWBYuv5yDikcnmDHDfuKtUUwbdQrjXj5?cluster=devnet) on Solana |
| A new owner can sell, after a NEAR-only handover | [Sell-back by the new owner](https://explorer.solana.com/tx/2d7rqzuc8sdA9dhZEntJJsTeBVJpBj5tZY11Y6rnk7GMCLxZiHijvNFKn1ZrwvJZ2bJd4GPbkxXwqg6SYegy4WJA?cluster=devnet); the proceeds landed in the NFT's own address |
| The seller can't keep the card by signing a transfer first | We proved this attack on an unprotected contract ([tx](https://explorer.solana.com/tx/287sh1C2HuCNznxsYBYvuKtZQ1zY3uUJoazEQ4strrkgsv15VUryMYEZfdU8svr4j7p4dCVxAZkaNThp4xsRLGge?cluster=devnet)), then fixed it. The `attack_*` tests in `pnpm test:contracts` show it refused. The full threat list is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) |
| Sign-in needs no wallet or seed phrase | A real email login signed a sell-back and a withdrawal with Privy's key (token 11 on the contract above) |
| A paid order recovers from outages, and is never paid for twice | Tests in `services/relayer/test/relayer.test.ts`; recovery also [ran live](docs/EVIDENCE.md) |

## How it works

1. **Checkout.** A NEAR Intents 1Click quote gives a deposit address on the buyer's chain. The relayer proves on Solana that the treasury received the money before it does anything else.
2. **Mint.** `mint_pack` creates one sealed NEP-171 token per paid order. The contract refuses a second mint for the same order.
3. **Buy.** The relayer asks Collector Crypt for a pack with the token's derived address as the recipient, inspects the transaction, and has the contract sign it through Chain Signatures.
4. **Open.** The card arrives at the token's address, and NEAR records it. The fairness proof is Collector Crypt's own VRF.
5. **Own.** Only the current NFT owner can call `sign_for_card`. The contract parses each Solana message before asking the MPC network to sign, so a seller can't pre-sign a way to take the card after selling.

The contract holds no user balances. The relayer has no way to sign for a card; only the current owner does.

## Run the whole thing yourself

This creates its own accounts, contract and treasury on test networks. It needs a NEAR testnet account holding test USDC from the [Tidepool faucet](https://app.usetidepool.tech/faucet), with its key in `~/.near-credentials/testnet/`.

```bash
DEMO_FUNDER=<your-testnet-account> pnpm demo:testnet --fresh
```

**You should see** all checks pass in about 6 minutes: pay, pull, attack refused, handover, sell-back and withdrawal. It writes the contract and relayer account names to `scripts/.demo-state.json`.

To use the web app against that deployment:

```bash
NEAR_NETWORK=testnet MINTENT_CONTRACT_ID=<contract> RELAYER_ACCOUNT=<relayer> DEMO_FUNDER=<your-testnet-account> pnpm relayer
pnpm web   # then open http://localhost:5173
```

**You should see** the gallery home page. Choose **Sign in**, then **Create my test account**, then buy a pack with **Pay with test USDC**. For email sign-in, set `VITE_PRIVY_APP_ID` in `apps/web/.env.local` to your own [Privy](https://dashboard.privy.io) app ID.

Browser tests, which need the relayer and web app running:

```bash
cd apps/web
node e2e/flow.mjs <screenshot-dir>    # two users: buy, open, hand over, sell back, withdraw
node e2e/shots.mjs <screenshot-dir>   # every page at four screen sizes
```

## Repo map

| Path | What it is |
| --- | --- |
| `contracts/mintent` | NEAR contract (Rust): NEP-171, signing policy, transfer locks |
| `packages/checkout` | NEAR Intents 1Click checkout, with mainnet, Tidepool and mock backends |
| `packages/shared` | Collector Crypt client, Solana derivation and transaction helpers |
| `services/relayer` | Order pipeline, sell-back and withdrawal, reconciliation, HTTP API |
| `apps/web` | React and Vite web app |
| `scripts` | `demo:testnet`, `verify:pull` and earlier feasibility spikes |
| `docs` | [Evidence](docs/EVIDENCE.md), [threat model](docs/THREAT-MODEL.md), [decisions](docs/DECISIONS.md), [plan](docs/PLAN.md) |

## Limits

- **No mainnet run yet.** Collector Crypt's mainnet purchase transaction hasn't been inspected by our checks, and a real mainnet sell-back hasn't happened.
- **Test payments aren't spent on the pack.** Tidepool's test USDC isn't the token Collector Crypt's devnet charges, so the testnet treasury pays from pre-stocked test funds. On mainnet both are real USDC.
- **Paying from other chains has been quoted, not executed.** Test payments came from NEAR USDC. Live mainnet quotes are in [docs/EVIDENCE.md](docs/EVIDENCE.md).
- **Sell-back timing on mainnet is unconfirmed.** Collector Crypt's docs say 72 hours, devnet offered 30 days, and 8 of 8 recent mainnet pulls were not available when checked. Those cards may already have been sold.
- **Redeeming a physical card is untested.** The path is to withdraw the card to your own Solana wallet, then redeem on Collector Crypt's site like any holder.
- **Trust assumptions.** The relayer controls the treasury's signatures and can write wrong records to the contract, though it can't take a card. `verify:pull` reads the chains directly for this reason. Details are in the threat model.
- **After 24 hours of failed retries, a stuck paid order needs a person.** There's no automated refund.

## Disclosures

- **Pre-hackathon code:** none. The first commit is dated 4 Nov 2026, inside the 1–14 Nov build window, and no template was used.
- **Independent project:** not affiliated with Collector Crypt. It uses only their public, keyless APIs. Card images and names shown in the app belong to their respective owners.
- **Age and risk:** random packs aren't for everyone. The app requires an 18+ confirmation, and shows odds and sell-back terms before payment.
- **Libraries:**
  - Contract: `near-sdk`, `near-contract-standards`, `near-workspaces`
  - TypeScript: `near-api-js`, `@solana/web3.js`, `bs58`, `@defuse-protocol/one-click-sdk-typescript`
  - Web: `react`, `vite`, `motion`, `lucide-react`, `uqr`, `@privy-io/react-auth`
  - Tests: `playwright-core`
- **Services:** NEAR Chain Signatures, NEAR Intents 1Click, Tidepool (community testnet of 1Click), Collector Crypt, Privy, public NEAR and Solana RPCs.

## License

[MIT](LICENSE)
