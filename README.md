<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/mintent-lockup.svg">
    <img src="apps/web/public/brand/mintent-lockup-ink.svg" alt="Mintent" width="280">
  </picture>
</p>

# Mintent

Real graded trading cards, paid for from any chain, owned as NEAR NFTs, and cashed out to any chain.

**The problem.** Tokenized collectibles are stuck on one chain: to buy a vaulted card you need that chain's wallet and coin, and the money you get back is stuck there too. Selling the token also doesn't reliably hand over the asset. A seller can sign a transfer of the underlying card first and sell the token afterwards. And if you let an agent manage the card, it usually gets the keys to everything.

Each pack you buy becomes a NEP-171 token on NEAR. The token controls its own Solana address through NEAR Chain Signatures, and that address holds the real card, which is backed by a physical graded slab in Collector Crypt's vault. **Transfer the NFT on NEAR and control of the card moves with it, with no Solana transaction.** Whoever holds the NFT can sell the card back, cash out the money as any coin on any chain, or withdraw the card, and the previous owner can't. Sign in with email or a wallet you already have.

**The Keeper** answers a question every agent wallet faces: how do you let an agent act with your money without giving it the keys to everything? Collector Crypt's sell-back offers have a deadline. An owner can let an agent sell their card back while the offer meets their minimum, either right away or only in the offer's last 24 hours, and then send the money to the owner's own address. The **contract** limits the agent to exactly that:
- only this card, sold into this NFT's own address
- only at or above the owner's minimum, until a set time
- payouts only to the address the owner chose, less Mintent's exact fee

It can't withdraw the card, send money anywhere else or transfer the NFT, even with a stolen key. We had it try five ways on testnet, and the contract refused all five on-chain. Its key is a NEAR function-call key that can call only those two Keeper methods, so a thief couldn't use it for anything else either. The card page shows what the Keeper is thinking. `pnpm verify:keeper` re-checks everything it did, from public data.

Built at NEAR HACKATHON for these tracks:
- **`nfts`:** each NFT is an account that holds a real card and money, and carries permissions. Its metadata changes when the card leaves (dynamic NFT, NEP-171).
- **`security`:** the Keeper is a policy-limited agent wallet. The contract enforces its policy, and NEAR enforces its function-call access key.
- **`agents`:** the Keeper is an agent that sells and pays out for its owner, and shows its reasoning.
- **`open`:** the whole product is chain abstraction: pay from any chain through NEAR Intents, own on NEAR, cash out anywhere.

### NEAR features used

| Feature | What it does here | Where |
| --- | --- | --- |
| NEAR Intents, 1Click API | Pay in: an exact-output quote turns any listed coin into USDC on Solana. Cash out: the NFT's own address swaps its USDC to any coin on any chain. | `packages/checkout`, `services/relayer/src/orders.ts`, `services/relayer/src/ops.ts` |
| Chain Signatures | Each NFT controls a Solana address derived from the contract and `card/<token id>`. The MPC network signs only what the contract approves. | `contracts/mintent/src/lib.rs` (`sign_for_card`, `keeper_sign`, `keeper_payout`) |
| NEP-171 NFT, dynamic metadata | One token per pull. Its title becomes "Sold back: …" or "Withdrawn: …" once the card leaves. | `contracts/mintent` |
| Function-call access keys | The Keeper's key can call only `keeper_sign` and `keeper_payout` on the contract. | `scripts/src/restrict-keeper-key.ts` |
| NEAR accounts for email and wallet users | Privy creates a NEAR account for each user, with an exportable key. No NEAR wallet or seed phrase is needed. | `apps/web/src/privy.tsx` |

The app explains all of this for users on its [How it works](https://web-testnet-production-2eb9.up.railway.app/how-it-works) page.

> **Most of the evidence below comes from public test networks. One full journey also ran on mainnet with real money (11 Nov, token 0 on `mintent.xinju.near`): paid from Base, card bought and opened, sold by the Keeper, and cashed out to Base.** NEAR Intents has no testnet, so the test site uses Tidepool, a community test version of the 1Click API. See [Limits](#limits).

**Hosted:** [testnet, free](https://web-testnet-production-2eb9.up.railway.app) · [mainnet, real money](https://mintent.up.railway.app)

## Try it in a browser, in 5 minutes, with nothing to install

On the [testnet site](https://web-testnet-production-2eb9.up.railway.app):

| Do | You should see |
| --- | --- |
| Choose **Sign in**, then **Create my test account** | Your new NEAR account in the top right. No email or wallet needed. |
| Scroll to the packs, choose **Open a $25 pack**, tick the 18+ box, then **Get payment details** | A deposit address and the exact amount, from a 1Click quote |
| Choose **Pay with test USDC** | The steps tick through: payment proven, NFT minted, pack bought, the draw. Takes 2–4 minutes. |
| Choose **Tear open your pack** | A real graded card from Collector Crypt's devnet, owned by your NFT |
| Choose **Your dashboard**, then come back to the pack another time | Leave mid-order and the dashboard shows it on its way, then offers **Open it**. Nothing names the card until you do. |
| Choose **View your card** | "Check it yourself": the NFT's owner on NEAR, its Solana address and who holds the card, each linked to an explorer |
| Choose **Sell back for USDC**, then **Confirm** | The card goes back to Collector Crypt, and the USDC lands in the NFT's own address |
| On a card you haven't sold, set a minimum below the offer and choose **Turn on the Keeper** | Within a minute, the Keeper's reasoning, then the sale |
| Open **How it works** | How the app uses NEAR Intents, Chain Signatures and the Keeper |

Test accounts get 3 free packs a day. Signing in with email, or with an Ethereum or Solana wallet, works too.

## Check it in 2 minutes, with no accounts or keys

Needs Node 22.22 or newer and pnpm.

```bash
pnpm install
pnpm verify:pull mintent-con-mw7mmwr5.testnet 0   # sold back by its new owner
pnpm verify:pull mintent-con-mw7mmwr5.testnet 1   # withdrawn to the owner's own wallet
pnpm verify:keeper mintent.xinju.near 0          # mainnet, real money: sold by the Keeper, inside the owner's permission
```

**You should see** `ALL CHECKS PASSED` for each, in under a minute. These commands read only public data from NEAR RPC, Solana RPC and Collector Crypt's verifier, and trust nothing from our servers. They check that:

- the NFT's owner matches the card record
- the card's address derives from the contract through the NEAR MPC network
- the card is where NEAR says it is on Solana
- the pack's random draw has a valid VRF proof
- for `verify:keeper`: every Keeper action was inside a live permission, for the right card, at or above the minimum, paid where the owner chose with exactly Mintent's fee, and landed on Solana. NearBlocks is used only to find the transactions.

`pnpm verify:keeper mintent-con-mw7mmwr5.testnet 25` checks a testnet sale that was also paid out to the owner's wallet, with five refused attacks. It takes a few minutes, because it reads older history from archival NEAR nodes.

```bash
pnpm --filter @mintent/checkout test   # 7 pass: checkout
pnpm --filter @mintent/relayer test    # 78 pass: order pipeline, sell-back, cash-out, recovery, Keeper, card addresses
pnpm test:web                          # 19 pass: the signing check refuses tampered messages and wrong fees; Privy signer; wallet payment encoding; card addresses
pnpm test:contracts                    # 81 unit tests + 1 sandbox run, including the attack and Keeper tests; needs Rust and cargo-near
```

Every step of the real runs, with transaction links, is in [docs/EVIDENCE.md](docs/EVIDENCE.md).

## What to look for

| Claim | How to check |
| --- | --- |
| It works on mainnet, with real money | Token 0 on `mintent.xinju.near`: [25.74 USDC paid from Base](https://basescan.org/tx/0xf1a36f8b87fc9627fe7d3a475552d30cb5dea679e94b9c676531012b9dcfe6e3) through NEAR Intents; a CGC 10 card ($18 insured) opened; the Keeper sold it back for $15.30 with its function-call key ([`keeper_sign`](https://nearblocks.io/txns/2YhVZmezx3PvGTjtmycVsESK7i4798WpBw9dL3z9KYpy)); 15.30 USDC cashed out to Base. `pnpm verify:keeper mintent.xinju.near 0` prints ALL CHECKS PASSED |
| The NFT controls a real card | Run `verify:pull`, or follow the [card asset](https://explorer.solana.com/address/FR2ckzK3V8TKYWBYuv5yDikcnmDHDfuKtUUwbdQrjXj5?cluster=devnet) on Solana |
| A new owner can sell, after a NEAR-only handover | [Sell-back by the new owner](https://explorer.solana.com/tx/2d7rqzuc8sdA9dhZEntJJsTeBVJpBj5tZY11Y6rnk7GMCLxZiHijvNFKn1ZrwvJZ2bJd4GPbkxXwqg6SYegy4WJA?cluster=devnet); the proceeds landed in the NFT's own address |
| The seller can't keep the card by signing a transfer first | We proved this attack on an unprotected contract ([tx](https://explorer.solana.com/tx/287sh1C2HuCNznxsYBYvuKtZQ1zY3uUJoazEQ4strrkgsv15VUryMYEZfdU8svr4j7p4dCVxAZkaNThp4xsRLGge?cluster=devnet)), then fixed it. The `attack_*` tests in `pnpm test:contracts` show it refused. The full threat list is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) |
| Sign-in needs no NEAR wallet or seed phrase | A real email login signed a sell-back and a withdrawal with Privy's key (token 11 on the contract above). `apps/web/e2e/signin.mjs` signs in with an Ethereum wallet too |
| Pay from another chain | A [payment on Base Sepolia](https://sepolia.basescan.org/tx/0x4c49ae3b52cba9df6d1331d922edb7bbe4b9872449d4a038eda794dfbdaa7ce7) produced token 13 |
| Cash out to any chain | Sell-back money arrived as USDC on [Base Sepolia](https://sepolia.basescan.org/address/0x55528b52ab7000887f0bf1543c5b878c2cae66ca) and on NEAR ([evidence](docs/EVIDENCE.md)) |
| The app won't sign what you didn't ask for | `apps/web/e2e/tamper.mjs` plays a compromised relayer against the real app: refused, nothing signed, card unmoved. `apps/web/e2e/verify.test.mts` covers the other attacks |
| An agent can act for you without being able to take anything | The Keeper's real key, refused five times on-chain: [withdraw the card](https://testnet.nearblocks.io/txns/DRXHsP5JVZ1fgJDunY4km5tH1je45xH91bzBGkhK69cb), [sell below the minimum](https://testnet.nearblocks.io/txns/b3snbsDCNESNHKD5RXWUKxJVLhZMut7fCLdjYq3nvAt), [take the sale](https://testnet.nearblocks.io/txns/FzJsheVo8Qus37TUMTu8vSDSdT6dHUdYrkWD9LvUfxgS), [pay itself](https://testnet.nearblocks.io/txns/6ctHushdEPgkxjdShxXgAa3A8prFuSTT6pdCYu2uowbP), [take a bigger fee](https://testnet.nearblocks.io/txns/EDx5ZEWGoAEK9zcCWTxmGH4cyC31d6Q45KyBGyGmxWR9). Then it sold at the owner's minimum and paid the owner exactly the sale less the fee. `pnpm verify:keeper mintent-con-mw7mmwr5.testnet 25` |
| The agent's key can't do anything else | Its key can call only `keeper_sign` and `keeper_payout` on the contract. With it, NEAR refused sending NEAR, adding a key, `nft_transfer`, `sign_for_card` and other contracts ([evidence](docs/EVIDENCE.md)). The live sale [BYssTepE…](https://testnet.nearblocks.io/txns/BYssTepE2KiuYNYPLfW6V4PCQGUxHxq5evUtCpeYfAV1) was signed with that key. On mainnet, `keeper.xinju.near` has the same kind of key ([tx](https://nearblocks.io/txns/9S64xTiQV5N2nerLUiuYzk52s2A3XVLe2tYJZ6b39Fy8)), and the same checks pass. `pnpm verify:keeper mintent-con-mw7mmwr5.testnet 32` |
| Pay from your wallet in one click | A wallet signed in through Privy [paid from Base Sepolia](https://sepolia.basescan.org/tx/0xcf36efe9d263996d001ad52feceefa96e57fd8f4d67f5f66d5c5c78b84ac8385) with one button and received token 27 |
| The NFT tells wallets the truth | `nft_token` for token 25 reads "Sold back: …" once its card has left |
| A paid order recovers from outages, and is never paid for twice | Tests in `services/relayer/test/relayer.test.ts`; recovery also [ran live](docs/EVIDENCE.md) |

## How it works

1. **Checkout.** A NEAR Intents 1Click quote gives a deposit address on the buyer's chain. The relayer proves on Solana that the treasury received the money before it does anything else.
2. **Mint.** `mint_pack` creates one sealed NEP-171 token per paid order. The contract refuses a second mint for the same order.
3. **Buy.** The relayer asks Collector Crypt for a pack with the token's derived address as the recipient, inspects the transaction, and has the contract sign it through Chain Signatures.
4. **Open.** The card arrives at the token's address, and NEAR records it. The fairness proof is Collector Crypt's own VRF.
5. **Own.** Only the current NFT owner can call `sign_for_card`. The contract parses each Solana message before asking the MPC network to sign, so a seller can't pre-sign a way to take the card after selling.
6. **Keep.** The owner can give an agent a narrow permission, `grant_keeper`. Its signing paths are limited:
   - `keeper_sign` signs only a Collector Crypt sell-back of this card, into the card's own address, at or above the owner's minimum, before the end.
   - `keeper_payout` signs only the owner's chosen address plus Mintent's exact fee. The contract ties every account in the message to the card's holder, which only that address can be, because only the holder can authorise the card's transfer. The permission clears when the NFT changes hands.
7. **Cash out.** Sell-back USDC lands in the NFT's own address. The owner picks a coin and chain, sees a quote, and signs. Mintent takes 1% (at least $0.25) on USDC leaving an NFT, shown before signing. Withdrawing the card is free. The NFT's address pays a 1Click deposit address, and the swap pays out. A refund returns to the NFT's address.

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
node e2e/keeper.mjs <screenshot-dir>  # the Keeper: five attacks refused on-chain, hold mode, then a sale and payout (relayer needs KEEPER_ACCOUNT)
node e2e/onepay.mjs <screenshot-dir>  # sign in with a wallet and pay from Base Sepolia in one click
node e2e/signin.mjs <screenshot-dir>  # wallet sign-in through Privy's real service, and sign-out
node e2e/dashboard.mjs <screenshot-dir> # leave checkout mid-order, then open the pack from the dashboard; readable card addresses
node e2e/shots.mjs <screenshot-dir>   # every page at four screen sizes
```

## Repo map

| Path | What it is |
| --- | --- |
| `contracts/mintent` | NEAR contract (Rust): NEP-171, signing policy, transfer locks, Keeper permissions |
| `packages/checkout` | NEAR Intents 1Click checkout, with mainnet, Tidepool and mock backends |
| `packages/shared` | Collector Crypt client, Solana derivation and transaction helpers |
| `services/relayer` | Order pipeline, sell-back and withdrawal, cash-out, the Keeper, reconciliation, HTTP API |
| `apps/web` | React and Vite web app |
| `scripts` | `demo:testnet`, `verify:pull`, `verify:keeper`, account and key setup, and earlier feasibility spikes |
| `deploy` | Dockerfiles for hosting on Railway ([guide](docs/DEPLOY.md)) |
| `docs` | [Evidence](docs/EVIDENCE.md), [threat model](docs/THREAT-MODEL.md), [decisions](docs/DECISIONS.md), [plan](docs/PLAN.md) |

## Limits

- **Test payments aren't spent on the pack.** Tidepool's test USDC isn't the token Collector Crypt's devnet charges, so the testnet treasury pays from pre-stocked test funds. On mainnet both are real USDC.
- **Wallet sign-in** was tested with injected test wallets, for Ethereum and for Solana, through Privy's real service, not with real extensions. NEAR's own wallets (HOT, Meteor) aren't supported.
- **Some wallets warn about the hosted sites.** Jupiter called the `*.up.railway.app` address "likely malicious", probably because scams use the same shared host. A custom domain is planned.
- **Redeeming a physical card is untested.** The path is to withdraw the card to your own Solana wallet, then redeem on Collector Crypt's site like any holder. Collector Crypt burns its token when it ships, and estimates [2–3 weeks in the US and about 5 elsewhere](https://docs.jup.ag/user-docs/trade/gacha/shipping). Redeeming from inside Mintent would need Collector Crypt's partner-only Shipping API.
- **Trust assumptions.** The relayer controls the treasury's signatures and can write wrong records to the contract. It can't act on a card by itself, and the app checks each message it prepares before signing. `verify:pull` reads the chains directly, so false records can be caught. The check's own limits, including BTC cash-outs and a replaced website, are in the threat model.
- **The Keeper's decision is a rule, not a model.** It sells while the offer meets your minimum, now or in the offer's last day. The safety comes from the contract, not from the agent being clever.
- **The Keeper pays out to Solana only.** Cash-outs to other chains go through a fresh quote each time, so they can't be pinned in advance in a permission.
- **One-click payment** has run with an injected test wallet on Base Sepolia, not a real browser extension.
- **After 24 hours of failed retries, a stuck paid order needs a person.** There's no automated refund.

## Disclosures

- **Pre-hackathon code:** none. The first commit is dated 4 Nov 2026, after the hackathon's announcement on 19 Oct (rule Q-001), and no template was used. This is our only NEAR HACKATHON project.
- **Independent project:** not affiliated with Collector Crypt. It uses only their public, keyless APIs. Card images and names shown in the app belong to their respective owners.
- **Age and risk:** random packs aren't for everyone. The app requires an 18+ confirmation, and shows odds and sell-back terms before payment.
- **Libraries:**
  - Contract: `near-sdk`, `near-contract-standards`, `hex`; tests: `near-workspaces`, `tokio`, `serde_json`, `anyhow`
  - TypeScript: `near-api-js`, `@solana/web3.js`, `bs58`, `@defuse-protocol/one-click-sdk-typescript`, `dotenv`
  - Web: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `motion`, `lucide-react`, `uqr`, `@privy-io/react-auth`, `@solana/kit`, `@solana-program/memo`, `@solana-program/system`, `@solana-program/token`
  - Tests and tooling: `playwright-core`, `viem`, `tsx`, `typescript`
- **AI coding assistant:** Claude Code (Anthropic) was used throughout the build. It wrote most of the code, tests and docs, and ran the test transactions, at the team's direction. The team chose the product and approved every mainnet transaction, and those decisions are logged in [docs/DECISIONS.md](docs/DECISIONS.md). AI-written code is allowed by the hackathon's rule Q-005.
- **Services:** NEAR Chain Signatures, NEAR Intents 1Click, Tidepool (community testnet of 1Click), Collector Crypt, Privy, public NEAR and Solana RPCs.

## License

[MIT](LICENSE)
