<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/mintent-lockup.svg">
    <img src="apps/web/public/brand/mintent-lockup-ink.svg" alt="Mintent" width="280">
  </picture>
</p>

# Mintent

Real graded trading cards, paid for from any chain, owned as NEAR NFTs, and cashed out to any chain.

Each pack you buy becomes a NEP-171 token on NEAR. The token controls its own Solana address through NEAR Chain Signatures, and that address holds the real card, which is backed by a physical graded slab in Collector Crypt's vault. **Transfer the NFT on NEAR and control of the card moves with it, with no Solana transaction.** Whoever holds the NFT can sell the card back, cash out the money as any coin on any chain, or withdraw the card, and the previous owner can't. Sign in with email or a wallet you already have.

Built at NEAR HACKATHON for the `nfts` track ("NFTs that do something"): each NFT here is an account that holds an asset and money.

> **Status, 9 Nov 2026: everything below has run on public test networks with no real money. Nothing has run on mainnet yet.** See [Limits](#limits).

**Try it:** [testnet, free](https://web-testnet-production-2eb9.up.railway.app) · [mainnet, real money](https://web-mainnet-production-b5e0.up.railway.app)

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
pnpm --filter @mintent/relayer test    # 65 pass: order pipeline, sell-back, cash-out, recovery
pnpm test:web                          # 16 pass: the signing check refuses tampered messages and wrong fees; Privy signer matches a local key
pnpm test:contracts                    # contract, including the attack tests; needs Rust and cargo-near
```

Every step of the real runs, with transaction links, is in [docs/EVIDENCE.md](docs/EVIDENCE.md).

## What to look for

| Claim | How to check |
| --- | --- |
| The NFT controls a real card | Run `verify:pull`, or follow the [card asset](https://explorer.solana.com/address/FR2ckzK3V8TKYWBYuv5yDikcnmDHDfuKtUUwbdQrjXj5?cluster=devnet) on Solana |
| A new owner can sell, after a NEAR-only handover | [Sell-back by the new owner](https://explorer.solana.com/tx/2d7rqzuc8sdA9dhZEntJJsTeBVJpBj5tZY11Y6rnk7GMCLxZiHijvNFKn1ZrwvJZ2bJd4GPbkxXwqg6SYegy4WJA?cluster=devnet); the proceeds landed in the NFT's own address |
| The seller can't keep the card by signing a transfer first | We proved this attack on an unprotected contract ([tx](https://explorer.solana.com/tx/287sh1C2HuCNznxsYBYvuKtZQ1zY3uUJoazEQ4strrkgsv15VUryMYEZfdU8svr4j7p4dCVxAZkaNThp4xsRLGge?cluster=devnet)), then fixed it. The `attack_*` tests in `pnpm test:contracts` show it refused. The full threat list is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) |
| Sign-in needs no NEAR wallet or seed phrase | A real email login signed a sell-back and a withdrawal with Privy's key (token 11 on the contract above). `apps/web/e2e/signin.mjs` signs in with an Ethereum wallet too |
| Pay from another chain | A [payment on Base Sepolia](https://sepolia.basescan.org/tx/0x4c49ae3b52cba9df6d1331d922edb7bbe4b9872449d4a038eda794dfbdaa7ce7) produced token 13 |
| Cash out to any chain | Sell-back money arrived as USDC on [Base Sepolia](https://sepolia.basescan.org/address/0x55528b52ab7000887f0bf1543c5b878c2cae66ca) and on NEAR ([evidence](docs/EVIDENCE.md)) |
| The app won't sign what you didn't ask for | `apps/web/e2e/tamper.mjs` plays a compromised relayer against the real app: refused, nothing signed, card unmoved. `apps/web/e2e/verify.test.mts` covers the other attacks |
| A paid order recovers from outages, and is never paid for twice | Tests in `services/relayer/test/relayer.test.ts`; recovery also [ran live](docs/EVIDENCE.md) |

## How it works

1. **Checkout.** A NEAR Intents 1Click quote gives a deposit address on the buyer's chain. The relayer proves on Solana that the treasury received the money before it does anything else.
2. **Mint.** `mint_pack` creates one sealed NEP-171 token per paid order. The contract refuses a second mint for the same order.
3. **Buy.** The relayer asks Collector Crypt for a pack with the token's derived address as the recipient, inspects the transaction, and has the contract sign it through Chain Signatures.
4. **Open.** The card arrives at the token's address, and NEAR records it. The fairness proof is Collector Crypt's own VRF.
5. **Own.** Only the current NFT owner can call `sign_for_card`. The contract parses each Solana message before asking the MPC network to sign, so a seller can't pre-sign a way to take the card after selling.
6. **Cash out.** Sell-back USDC lands in the NFT's own address. The owner picks a coin and chain, sees a quote, and signs. Mintent takes 1% (at least $0.25) on USDC leaving an NFT, shown before signing. Withdrawing the card is free. The NFT's address pays a 1Click deposit address, and the swap pays out. A refund returns to the NFT's address.

The contract holds no user balances. Only the current owner can request a signature for a card; the relayer can't do it alone.

Whichever way you sign in, your NFTs belong to a NEAR account whose key Privy holds and you can export. A connected wallet is your login, and it doesn't own the NFT. The card is always a Solana asset, so withdrawing it needs a Solana address.

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

**You should see** the gallery home page. Choose **Sign in**, then **Create my test account**, then buy a pack with **Pay with test USDC**. For email and wallet sign-in, set `VITE_PRIVY_APP_ID` in `apps/web/.env.local` to your own [Privy](https://dashboard.privy.io) app ID.

Browser tests, which need the relayer and web app running:

```bash
cd apps/web
node e2e/flow.mjs <screenshot-dir>    # two users: buy, open, hand over, sell back, withdraw
node e2e/anychain.mjs <screenshot-dir> # pay from Base Sepolia, then cash out to NEAR and Base
node e2e/tamper.mjs <screenshot-dir>  # a compromised relayer against the real app
node e2e/signin.mjs <screenshot-dir>  # wallet sign-in through Privy's real service, and sign-out
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
| `deploy` | Dockerfiles and Railway config for hosting ([guide](docs/DEPLOY.md)) |
| `docs` | [Evidence](docs/EVIDENCE.md), [threat model](docs/THREAT-MODEL.md), [decisions](docs/DECISIONS.md), [plan](docs/PLAN.md) |

## Limits

- **No mainnet run yet.** One real, unsigned mainnet purchase transaction passed our safety check, with nothing signed or sent. No purchase or sell-back has run on mainnet.
- **Test payments aren't spent on the pack.** Tidepool's test USDC isn't the token Collector Crypt's devnet charges, so the testnet treasury pays from pre-stocked test funds. On mainnet both are real USDC.
- **Any-chain money hasn't moved for real yet.** On test networks, payment ran from Base and NEAR, and cash-outs to NEAR and Base. Other chains have live mainnet quotes only ([evidence](docs/EVIDENCE.md)).
- **Payment proof on mainnet is unconfirmed.** Mainnet swaps are confidential. If 1Click doesn't report the payout's hash, the relayer finds the payment on the treasury's account instead, which has only run against test networks.
- **The mainnet cash-out is unit-tested only.** Testnet sell-back money is a token Tidepool doesn't take, so there the treasury funds the swap. On mainnet the NFT's address pays directly.
- **Wallet sign-in** used an injected test wallet, not a real extension. Solana wallets aren't tested. NEAR's own wallets (HOT, Meteor) aren't supported.
- **Sell-back timing on mainnet is unconfirmed.** Collector Crypt's docs say 72 hours, devnet offered 30 days, and 8 of 8 recent mainnet pulls were not available when checked. Those cards may already have been sold.
- **Redeeming a physical card is untested.** The path is to withdraw the card to your own Solana wallet, then redeem on Collector Crypt's site like any holder.
- **Trust assumptions.** The relayer controls the treasury's signatures and can write wrong records to the contract. It can't act on a card by itself, and the app checks each message it prepares before signing. `verify:pull` reads the chains directly, so false records can be caught. The check's own limits, including BTC cash-outs and a replaced website, are in the threat model.
- **After 24 hours of failed retries, a stuck paid order needs a person.** There's no automated refund.

## Disclosures

- **Pre-hackathon code:** none. The first commit is dated 4 Nov 2026, inside the 1–14 Nov build window, and no template was used.
- **Independent project:** not affiliated with Collector Crypt. It uses only their public, keyless APIs. Card images and names shown in the app belong to their respective owners.
- **Age and risk:** random packs aren't for everyone. The app requires an 18+ confirmation, and shows odds and sell-back terms before payment.
- **Libraries:**
  - Contract: `near-sdk`, `near-contract-standards`, `near-workspaces`
  - TypeScript: `near-api-js`, `@solana/web3.js`, `bs58`, `@defuse-protocol/one-click-sdk-typescript`
  - Web: `react`, `vite`, `motion`, `lucide-react`, `uqr`, `@privy-io/react-auth`, `@solana/kit`, `@solana-program/memo`, `@solana-program/system`, `@solana-program/token`
  - Tests: `playwright-core`, `viem`
- **Services:** NEAR Chain Signatures, NEAR Intents 1Click, Tidepool (community testnet of 1Click), Collector Crypt, Privy, public NEAR and Solana RPCs.

## License

[MIT](LICENSE)
