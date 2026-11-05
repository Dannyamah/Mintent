# Mintent: Build Plan (5 Nov to 14 Nov 2026, 23:59 UTC)

Last updated: **5 Nov 2026**. All dates and times are UTC. Anything marked **(approval)** needs your explicit OK first.

**Design:** Mintent is a NEAR front end to Collector Crypt (CC) packs (`RESEARCH-FINDINGS.md` section 5.2).
- You pay for each pack through a NEAR Intents checkout, from any chain.
- Each pull becomes a NEP-171 token on NEAR whose Chain Signatures-derived Solana address holds the real card.
- Transferring the token transfers control of the card.

## Status (5 Nov)

| Item | State |
| --- | --- |
| Research docs (`CONTEXT.md`, `RESEARCH-FINDINGS.md`) | Done |
| Repo scaffold: pnpm workspace, MIT LICENSE, `.env.example`, `.gitignore` | Done |
| Contract `contracts/mintent`: NEP-171, `card/<id>` derivation, owner-only `sign_for_card`, relayer-only `mint_pack` (deduplicated by `order_id`), `record_open`, `record_release`, `sign_for_treasury`, events | Done. 18 unit tests plus 1 sandbox end-to-end test pass. |
| Testnet deploy | `app2.mintent-dev-mw21w9ki.testnet` (current build, with `order_id`) |
| MPC signing of real CC devnet pack transactions | **Works.** Typically 11.7–13.6 s, but the **tail reaches 46.6 s**. The devnet blockhash window is only about 36 s. |
| Blocker 1 (receive and transfer a CC card) | **VERIFIED on devnet (Core card), 5 Nov.** Real pull into the `card/0` address, then moved out using the owner's contract signature plus a treasury fee payer with a durable nonce. pNFT is untested. |
| Blocker 3 (marketplace and buyback by signed API transactions) | **Open.** |
| Blocker 2 (redemption) | **Open.** Needs a CC `partnerSlug`. |
| Blocker 4 (pricing) | **Verified.** |

## Scope

### Must-have (the demo fails without these)

1. **Contract `mintent`** (largely built):
   - NEP-171 tokens with states sealed → opened → released.
   - Per-token Solana address via Chain Signatures (`card/<token_id>`).
   - Only the current owner can call `sign_for_card`.
   - The relayer-only `mint_pack(order_id, …)` mints exactly once per paid checkout. The contract holds **no user balances**.
   - Only the relayer can sign for the treasury.
   - Events for every step.
   - Unit tests plus sandbox tests with a mock signer.
2. **Checkout through NEAR Intents 1Click, one order per pack** (`packages/checkout`):
   - An EXACT_OUTPUT quote for the pack price, payable from any supported asset.
   - Destination: USDC on Solana at the contract's treasury address (`recipientType: DESTINATION_CHAIN`).
   - `order_id` is the quote's deposit address.
   - The status poller drives the order.
   - Refunds are handled by 1Click and shown in the UI.
   - Backends, chosen by `ONECLICK_BASE_URL`: mainnet 1Click, **Tidepool** (testnet and CI default) and a fixture mock (offline fallback).
3. **Relayer order pipeline** (`services/relayer`):
   1. Checkout SUCCESS.
   2. `mint_pack`.
   3. CC `generatePack` (player = treasury, `altPlayerAddress` = the token's card address).
   4. `sign_for_treasury`, then submit.
   5. `openPack`.
   6. `record_open`.
   - Idempotent per `order_id`, with a retry when the blockhash expires.
4. **One exit that proves ownership moves with the token:** transfer the NEP-171 token; the **new** owner sells the card back (CC buyback or a `cc_buyback` quote); the old owner's signing attempt fails.
5. **Web app:** Privy email/passkey sign-in, pack shop, checkout (pay from any chain), the opening reveal, a card page with a proof panel, transfer and sell back.
6. **AI-judge path:**
   - `pnpm demo:testnet` runs NEAR testnet, a Tidepool checkout, Solana devnet and CC devnet end to end, headless. It falls back to fixtures if Tidepool `/v0/health` or CC devnet is down.
   - `pnpm verify:pull <token_id>` re-checks every claim.
   - The README uses "do X → see Y" steps.
7. **One real mainnet run (approval),** recorded with hashes in the README.

### Nice-to-have (in this order, only after the must-haves)

1. "Withdraw to my Solana wallet" (cheap; also the redemption fallback).
2. A **"pay from any chain" checkout demo page for a non-Mintent merchant**, reusing `packages/checkout`. This answers Illia's "universal checkout" idea and supports a `realworld` entry.
3. In-app redemption (needs a CC `partnerSlug`).
4. List and cancel on the CC marketplace.
5. Cash-out to any chain via Intents.
6. NEAR Auth passkeys (mainnet approval). EVM-chain CC packs. Hosted demo kept up until 25 Nov.

### Out of scope

Own inventory, own odds, a pricing engine, Magic Eden/Tensor connectors, OutLayer VRF, in-contract user balances.

## Day-by-day plan

| Day | Goal | Exit criteria |
| --- | --- | --- |
| **Wed 5 Nov** | Finish Spike S1 ✅ (done) | Redeploy the contract to a fresh testnet sub-account. Get devnet SOL to the treasury (Tidepool intents faucet, then a 0.005 SOL withdrawal, or faucet.solana.com). Get USDC-Dev (`Gh9Zw…KtJr`) for the treasury. Pay for and open a CC devnet `pokemon_25` with the card going to `card/<id>`. **Transfer the card out with an owner-requested contract signature.** Record the card standard (Core, pNFT or cNFT). |
| **Thu 6 Nov** | Spike S2 and decision points | Buyback of the S1 card by the token owner, via `/api/buyback` and via a `cc_buyback` quote. List and cancel on the CC devnet marketplace via the contract. **12:00 and 18:00 decisions (below).** Start `packages/checkout` against Tidepool: quote, deposit, status, refund, appFees. |
| **Fri 7 Nov** | Relayer pipeline | `services/relayer` order state machine (SQLite), from checkout SUCCESS to `record_open`. Retry when the blockhash expires. Idempotent by `order_id`. Checkout package complete with the Tidepool and mock backends, including Tidepool's simulated failures. |
| **Sat 8 Nov** | Headless end-to-end | `pnpm demo:testnet` passes from a clean clone: checkout → mint → buy → open → transfer → sell back by the new owner → old owner refused. `pnpm verify:pull` written. Withdraw-to-wallet if time allows. |
| **Sun 9 Nov** | Web app v1 | Privy sign-in, pack shop (neutral names; live odds, EV and buyback from `/api/machines`), checkout UI, reveal, card page with proof panel, transfer, sell back. Runs against testnet and devnet. |
| **Mon 10 Nov** | Mainnet readiness | Mainnet config, 1Click partner key with `appFees`. `dry: true` quotes for BTC→Solana USDC and SOL→Solana USDC. **(approval)** Deploy the contract to mainnet. Merchant checkout demo page if ahead of schedule. |
| **Tue 11 Nov** | **Mainnet golden run (approval, ~$130–180 outlay)** | Pay for a $50 pack from BTC (or SOL) through the checkout. The card arrives at the token's address. Transfer the token, and the second owner sells back. Record every hash. Fix what breaks. |
| **Wed 12 Nov** | README and hardening | Machine-readable README: setup in one command, do X → see Y, honest labels ("mainnet-only", "confidential swap: no public swap hash", "testnet uses Tidepool and pre-stocked USDC-Dev"), disclosures, list of libraries. Edge cases: pack expiry at 2 hours, CC 429/503, MPC timeout, checkout refund. Hosted demo. Second mainnet run only if needed **(approval)**. |
| **Thu 13 Nov** | Video and X draft | Record the < 2 min video (script below). Draft the X post (@NEARProtocol, #NEARHackathon). Freeze features at 18:00. |
| **Fri 14 Nov** | Submit | By 12:00: final clean-clone run, tag `hackathon-submission`. **(approval)** You make the repo public and post on X. I print the API payload; you confirm; I submit **(approval)** well before 23:59. |

### Decision points

- **Durable nonces (adopted 5 Nov, D-011):** every Solana transaction Mintent builds uses the treasury's durable nonce. CC-built partially signed transactions (purchase, `/api/buyback`) can't, so on expiry the relayer requests a fresh transaction and retries (unpaid packs simply expire).
- **6 Nov 12:00, MPC latency.** Now: 12.3–13.6 s through the contract, inside the window. Switch the purchaser to a hot key (with `altPlayerAddress` still set to the MPC card address) **only if** more than 1 in 5 S1/S2 purchases miss the window. Buybacks use `cc_buyback` quotes (600 s) when CC's ~30 s window is missed.
- **6 Nov 18:00, Blocker 1 (card transfer from the derived address):** if the pNFT transfer fails, try v0 transactions with lookup tables and the CC rule-set accounts. If it still fails, restrict to Core or cNFT machines. If those fail too, switch to a contract-held vault address (`vault`) with NEP-171 claims.
- **7 Nov, CC devnet or Tidepool unavailable:** build against recorded fixtures and a mock server for the AI-judge path. The mainnet run remains the proof.
- **Testnet token mismatch (fixed rule):** Tidepool's devnet USDC (`7paf…r4Xr`) ≠ CC's devnet USDC-Dev. On testnet the treasury is pre-stocked with USDC-Dev, and the checkout settlement is recorded but not spent. On mainnet both are real USDC and the checkout payment funds the pack. The README states this.
- **10 Nov, no `partnerSlug`:** ship withdraw-to-wallet, then redeem on collectorcrypt.com, and say so in the README.
- **11 Nov 20:00, mainnet run failed:** fix it on the 12th. If it's still blocked, submit with the testnet demo plus whatever mainnet steps worked, labelled honestly.

### Decisions still open (yours)

1. Confirm the design above (front end to CC plus card-account NFTs). Work since "go" assumes it.
2. Email Collector Crypt for a `partnerSlug` (devnet and prod).
3. Tracks: **`nfts` + `realworld` + `open`** is my recommendation (`realworld` is justified by the reusable checkout). `games` is not recommended.
4. Mainnet budget (~$130–180 by 10 Nov) and the source chain (BTC or SOL).
5. Mainnet payout account, Privy app id, 1Click partner key application.
6. Neutral pack names in our UI.

## Demo script (≤ 2 min)

1. **0:00** "Real graded cards, paid from any chain, owned as a NEAR NFT." Email or passkey sign-in; no wallet popup.
2. **0:15** Pick the $50 pack, then **Checkout:** choose BTC and get a deposit address. Payment lands (pre-recorded clip with the BTC hash, because BTC confirmations are slow).
3. **0:35** A sealed NEP-171 token is minted on NEAR (show the transaction).
4. **0:50** Open it. The reveal shows the slab (NFT media) and insured value. The proof panel shows: CC VRF verify ✓, the Solana delivery transaction to the token's derived address, and `derived_public_key("card/<id>", <contract>, 1)` matching it.
5. **1:15** Transfer the NEAR token to a friend. No Solana transaction happens; the friend now controls the slab.
6. **1:30** The friend taps "Sell back" and USDC arrives. The old owner's signing attempt is rejected (show the failed transaction).
7. **1:45** Withdraw or redeem, then close: repo link and "every claim has a `verify` command".

## Repo structure

```
mintent/
├─ README.md               # machine-readable: what/why, one-command setup, do X → see Y, verify claims, disclosures
├─ LICENSE                 # MIT                                         [done]
├─ .env.example            # placeholders only; keys live in ~/.near-credentials  [done]
├─ package.json, pnpm-workspace.yaml                                      [done]
├─ contracts/
│  ├─ mintent/             # Rust, near-sdk 5.30, cargo-near 0.22, near-contract-standards  [done: skeleton]
│  │  ├─ src/lib.rs, src/tests.rs
│  │  └─ tests/sandbox.rs  # near-workspaces 0.24 (feature "unstable") + mock signer
│  └─ mock-signer/         # test-only stand-in for v1.signer          [done]
├─ packages/checkout/      # 1Click checkout: quote → deposit address → status; backends mainnet | tidepool | mock
├─ packages/shared/        # types, CC API client, Solana derivation & tx helpers, per-network config
├─ services/relayer/       # TypeScript: order state machine (SQLite), CC gacha & marketplace, MPC orchestration
├─ apps/web/               # Next.js + Privy + @hot-labs/near-connect + near-api-js 7
├─ scripts/                # create-testnet-account, deploy-testnet, spikes [done]; demo-testnet, verify-pull, fixtures/
└─ docs/                   # CONTEXT.md, RESEARCH-FINDINGS.md, PLAN.md
```

### Stack and reasons

| Choice | Why |
| --- | --- |
| **Rust contract**, near-sdk 5.30 plus `near-contract-standards` | NEP-171 is the `nfts` track's hint. The standard implementation saves days. |
| **Mock signer for tests** | `v1.signer` isn't in the sandbox. A mock with the same interface tests the authorization paths deterministically. |
| **No balances in the contract** | One checkout per pack means no custody of user funds in the contract and less code. `order_id` deduplication prevents double mints. |
| **TypeScript relayer and checkout** | CC, Solana (`@solana/web3.js` 3.1), the 1Click SDK and Privy are all TypeScript-first. |
| **Build Solana transactions off-chain, sign on-chain** | The contract decides *who* may sign for *which* path. Card owners sign anything for their own card. The treasury is relayer-only, which is a documented trust assumption. |
| **Tidepool for testnet 1Click** | The only Intents path on testnet, using the same `/v0` API and the official SDK through a base-URL swap. It's unofficial and custodial: test tokens only, never our partner JWT, a fixture fallback, and no reliance on swap hashes (mainnet swaps are confidential). |
| **Privy via near-connect** | Mainnet email or passkey sign-in with no approval queue. near-connect also offers HOT and Meteor. |
| **SQLite in the relayer** | Durable order state and idempotency with zero infrastructure. |
| **No OutLayer in the must-haves** | CC's ECVRF already proves fairness. OutLayer's TEE-signature "VRF" would be weaker and duplicative. |
