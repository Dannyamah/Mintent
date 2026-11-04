# Mintent: Revised Build Plan (5 Nov to 14 Nov 2026, 23:59 UTC)

This plan assumes you accept the pivot in `RESEARCH-FINDINGS.md` section 5.2: Mintent becomes a NEAR front end to Collector Crypt packs, and each pull is a card-account NEP-171 token. If you keep the rundown's own-packs design, this plan doesn't apply.

All dates are UTC. Anything marked **(approval)** needs your explicit OK first.

## Scope

### Must-have (the demo fails without these)

1. **NEAR contract `mintent`:**
   - NEP-171 tokens with states: sealed, opened, released.
   - Per-token Solana address derived through Chain Signatures (`path = "card/<token_id>"`).
   - `sign_for_card(token_id, payload)` only when the predecessor is the token owner.
   - Treasury signing restricted to the relayer role, and only for paid orders.
   - User balances credited from deposits.
   - Events for every step.
   - Tests via near-workspaces with a mock signer.
2. **Card delivery:** the relayer buys a CC pack and sets `altPlayerAddress` to the token's derived address. Then `openPack`, and the contract records memo, roll, mint and CC verify URL.
3. **One exit path that proves ownership moves with the token:**
   - Transfer the NEP-171 token.
   - The new owner sells the card back (CC buyback or `cc_buyback` quote).
   - USDC goes to an address the new owner chooses.
4. **Funding through NEAR Intents 1Click** from at least BTC or SOL. Mainnet only. Use `dry: true` quotes in tests.
5. **Web app:** Privy email/passkey sign-in, fund, buy and open pack, a card page with a proof panel, transfer, and sell back.
6. **AI-judge path:** one command (`pnpm demo:devnet`) runs testnet plus Solana devnet plus dev-gacha end to end. `pnpm verify:pull <token_id>` re-checks every claim. The README uses "do X → see Y" steps, and there's a LICENSE.
7. **One real mainnet run (approval),** recorded with hashes in the README.

### Nice-to-have (only after the must-haves work)

- Redemption in the app (needs a CC `partnerSlug`). Otherwise, "withdraw to my Solana wallet" (cheap to add, so do it if time allows).
- List and cancel on the CC marketplace from the app.
- Purchaser = MPC-derived treasury key, so the NEAR MPC signature seeds CC's VRF (only if MPC latency fits the ~30 s window).
- Cash-out to any chain via Intents.
- NEAR Auth passkeys (needs mainnet approval). EVM-chain CC packs.
- Hosted demo kept up until 25 Nov.

### Out of scope

Own inventory, own odds, a pricing engine, Magic Eden/Tensor connectors, OutLayer VRF, multiple pack tiers beyond what CC offers.

## Day-by-day plan

| Day | Goal | Exit criteria |
| --- | --- | --- |
| **Wed 5 Nov** | Decisions and the spike | You decide on the pivot, tracks, CC email and budget. **You** create the testnet accounts, Privy app and 1Click partner application. Scaffold the repo and LICENSE. **Spike S1 (Blocker 1):** derive a Solana address via `v1.signer-prod.testnet`, buy a dev-gacha `pokemon_25` with `altPlayerAddress` set to the card address, `openPack`, then transfer the card out via an MPC signature. Log every `sign` latency. |
| **Thu 6 Nov** | Spike S2 plus the contract skeleton | **Spike S2 (Blocker 3):** CC marketplace devnet list and cancel via MPC; buyback via `/api/buyback` and via a `cc_buyback` quote. Contract: NEP-171, `derive`, `sign_for_card` with an owner check, mock-signer tests. **Decision point at 12:00 (see below).** |
| **Fri 7 Nov** | Contract complete on testnet | Orders, balances, relayer role, treasury signing, sealed→opened update, events. All tests green. Deploy to testnet. |
| **Sat 8 Nov** | Relayer service | TypeScript service. CC client (gacha and marketplace), Solana transaction builders (v0 with lookup tables for pNFT), MPC signature orchestration with retry on blockhash expiry, idempotency keyed by order id. 1Click client using `dry` quotes. `pnpm demo:devnet` passes headless. |
| **Sun 9 Nov** | Web app v1 | Privy sign-in, balance, pack shop (neutral names, live odds/EV/buyback from `/api/machines`), opening animation, card page with proof panel, transfer, sell back. Runs against testnet and devnet. |
| **Mon 10 Nov** | Mainnet readiness | `verify:pull` script. Mainnet config. 1Click partner key wired in (`appFees`). **(approval)** Deploy the contract to mainnet. `dry: true` quotes BTC→USDC, SOL→USDC. Redemption or withdraw path if there's a slug. |
| **Tue 11 Nov** | **Mainnet golden run (approval, about $130–180 outlay)** | Fund from BTC (or SOL), buy a $50 pack, card arrives at the token address, transfer the token, the second owner sells back. Record every hash and screenshot. Fix whatever breaks. |
| **Wed 12 Nov** | Hardening and README | README for machine readers, with setup in one command, demo steps, honest labels for "mainnet-only" and "confidential swap: no public hash", disclosures and a list of libraries. Edge cases: pack expiry at 2 hours, CC 429/503, MPC timeout. Second mainnet run only if the first failed **(approval)**. |
| **Thu 13 Nov** | Demo video and X post draft | Record the < 2 min video (script below). Draft the X post with @NEARProtocol and #NEARHackathon. Check the hosted demo. Freeze features at 18:00. |
| **Fri 14 Nov** | Submit | By 12:00: final test run, tag `hackathon-submission`. **(approval)** You make the repo public and post on X. I print the API payload for your confirmation, then submit **(approval)**, well before 23:59 UTC. |

### Decision points

- **6 Nov, 12:00, MPC latency:** if the median `sign` round trip exceeds ~12 s, or more than 1 in 5 attempts misses CC's 30 s window, buy from a hot purchaser key with `altPlayerAddress` set to the card address. Do buybacks with `cc_buyback` quotes (600 s), using our own transactions and a fresh blockhash.
- **6 Nov, 18:00, Blocker 1:** if pNFT transfer from the derived address fails:
  - try the v0 transaction with lookup tables and the CC rule set accounts;
  - if it still fails, limit the demo to Core or cNFT machines;
  - if those fail too, switch to a custodial vault address held by the contract (path `vault`) with NEP-171 claims. Exits still go through contract signatures.
- **7 Nov, CC devnet unavailable:** build against recorded fixtures plus a mock CC server for the AI-judge path. The mainnet run proves the real integration.
- **10 Nov, no `partnerSlug`:** ship "withdraw to my Solana wallet, then redeem on collectorcrypt.com" and say so in the README.
- **11 Nov 20:00, mainnet run failed:** fix it on the 12th. If it's still blocked, submit with the testnet/devnet demo plus the parts of the mainnet run that worked, labelled honestly.

## Demo script (≤ 2 min)

1. **0:00** "Real graded cards, opened from any chain, owned as a NEAR NFT." Sign in with email or passkey; there's no wallet popup.
2. **0:15** Fund: a 1Click deposit address for BTC (pre-funded clip, with the BTC hash shown), and the balance lands in Mintent.
3. **0:35** Buy the $50 pack. A sealed NEP-171 token is minted on NEAR (show the transaction).
4. **0:50** Open it. The card reveal shows the slab (NFT media) and insured value. The proof panel shows: CC VRF verify ✓, Solana delivery transaction to the token's derived address, and `derived_public_key("card/42", mintent.near, 1)` matching it.
5. **1:15** Transfer the NEAR token to a friend. No Solana transaction happens; the friend now controls the slab.
6. **1:30** The friend taps "Sell back". USDC arrives at the friend's chosen address. The old owner's attempt to sign is rejected (show the failed transaction).
7. **1:45** "Redeem the physical card" (or withdraw), and close: repo link, "every claim has a `verify` command".

## Proposed repo structure (not scaffolded yet)

```
mintent/
├─ README.md               # machine-readable: what/why, one-command setup, do X → see Y, verify claims, disclosures
├─ LICENSE                 # MIT
├─ .env.example            # every key as a placeholder; no secrets committed
├─ package.json, pnpm-workspace.yaml, Makefile (thin wrappers)
├─ contracts/
│  ├─ mintent/             # Rust, near-sdk 5.30, cargo-near 0.22, near-contract-standards (NEP-171/177/178)
│  │  ├─ src/{lib.rs, nft.rs, orders.rs, signer.rs, events.rs}
│  │  └─ tests/            # near-workspaces 0.24: transfer-then-sign, unauthorized sign, order lifecycle
│  └─ mock-signer/         # test-only stand-in for v1.signer (same sign/derived_public_key interface)
├─ services/relayer/       # TypeScript (Node 22): CC gacha & marketplace clients, Solana tx builders,
│                          # MPC orchestration, 1Click client, order state machine (SQLite)
├─ apps/web/               # Next.js + Privy + @hot-labs/near-connect + near-api-js 7
├─ packages/shared/        # types, CC API client, Solana derivation & tx helpers, config per network
├─ scripts/                # derive-address.ts, demo-devnet.ts, verify-pull.ts, fixtures/
└─ docs/                   # CONTEXT.md, RESEARCH-FINDINGS.md, PLAN.md, ARCHITECTURE.md (later)
```

### Stack and reasons

| Choice | Why |
| --- | --- |
| **Rust contract**, near-sdk 5.30 plus `near-contract-standards` | NEP-171 is the track's hint. The standard implementation saves days. Rust is what the NEAR AI judges and docs expect. |
| **Mock signer for tests** | `v1.signer` isn't available in the sandbox. A mock with the same interface lets us test the authorization paths deterministically. |
| **TypeScript relayer** | CC, Solana (`@solana/kit` 8.6 / `@solana/web3.js` 3.1), `chainsig.js`, the 1Click SDK and Privy are all TypeScript-first. |
| **Build Solana transactions off-chain, sign on-chain** | The contract checks *who* may sign for which path, not the Solana semantics. That's simpler than `omni-transaction` in the contract. Card owners can sign anything for their own card (it's theirs). The treasury path is relayer-only, which is an explicit, documented trust assumption. |
| **Privy via near-connect** | Mainnet sign-in with email or passkey and no approval queue. near-connect also offers HOT and Meteor for crypto users. |
| **pnpm workspace with Make wrappers** | One-command setup for the AI judges (`pnpm i && pnpm demo:devnet`). |
| **SQLite in the relayer** | Durable order state and idempotency with zero infrastructure. Hosted demo on a single box. |
| **No OutLayer in the must-haves** | CC's ECVRF already proves fairness. OutLayer's TEE-signature "VRF" would be weaker and duplicative. OutLayer stays an optional add-on, credited if used. |
