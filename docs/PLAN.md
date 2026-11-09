# Mintent: Build Plan (5 Nov to 14 Nov 2026, 23:59 UTC)

Last updated: **8 Nov 2026**. All dates and times are UTC. Anything marked **(approval)** needs your explicit OK first.

**Design:** Mintent is a NEAR front end to Collector Crypt (CC) packs (`RESEARCH-FINDINGS.md` section 5.2), built only on CC's public, keyless APIs. No partnership or CC-issued key is needed; any partnership comes after the full build (D-022).
- You pay for each pack through a NEAR Intents checkout, from any chain.
- Each pull becomes a NEP-171 token on NEAR whose Chain Signatures-derived Solana address holds the real card.
- Transferring the token transfers control of the card.

## Status (8 Nov)

| Item | State |
| --- | --- |
| Research docs (`CONTEXT.md`, `RESEARCH-FINDINGS.md`) | Done |
| Repo scaffold: pnpm workspace, MIT LICENSE, `.env.example`, `.gitignore` | Done |
| Contract `contracts/mintent`: NEP-171, `card/<id>` derivation, owner-only `sign_for_card`, relayer-only `mint_pack` (deduplicated by `order_id`), `record_open`, `record_release`, `sign_for_treasury`, events | Done. 18 unit tests plus 1 sandbox end-to-end test pass. |
| Testnet deploy | `app2.mintent-dev-mw21w9ki.testnet` (current build, with `order_id`) |
| MPC signing of real CC devnet pack transactions | **Works.** Typically 11.7–13.6 s, but the **tail reaches 46.6 s**. The devnet blockhash window is only about 36 s. |
| Blocker 1 (receive and transfer a CC card) | **VERIFIED on devnet (Core card), 5 Nov.** Real pull into the `card/0` address, then moved out using the owner's contract signature plus a treasury fee payer with a durable nonce. pNFT is untested. |
| Blocker 3 (marketplace and buyback by signed API transactions) | **VERIFIED on devnet (5 Nov):** standard buyback, `cc_buyback` sellback by a *new* owner after a NEAR transfer (old owner refused), withdrawal to the owner's own address, marketplace list and cancel. |
| Card standard | Mainnet $50/$100 prizes are Core (15/15), so pNFT support is out of scope (D-012). |
| Contract hardening | **Done 8 Nov.** Signing policy and transfer locks after the pre-sign attack was proven (D-015, `THREAT-MODEL.md`). 46 unit tests and a sandbox run. |
| `packages/checkout`, `services/relayer` | **Done 8 Nov.** 7 + 31 tests. HTTP API smoke-tested. |
| `pnpm demo:testnet` | **Passes from nothing: 23/23 checks in 6.3 min on real networks** (`EVIDENCE.md`). |
| Web app | **Working on testnet, 8 Nov:** rebuilt with motion and depth (D-025): gallery home page, pack shop and detail pages, checkout, tap-to-tear reveal, dashboard, card page with proof panel, transfer, sell back, withdraw, security page. Two-user browser test passes on real networks, 18 of 18 (`apps/web/e2e/flow.mjs`). Privy email sign-in works on testnet with live signing, 9 Nov (D-026). Open for mainnet prep: no retry path for `needs_attention` orders; check real sell-back availability. |
| Mainnet | **Nothing run yet.** Dry quotes only. |
| Blocker 2 (redemption) | **Decided (D-022):** withdraw the card to the owner's own Solana wallet, then redeem on Collector Crypt's site. No partnership needed. |
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
5. **Withdraw to my own Solana wallet:** the owner moves the card out, which releases the token. This is how a card is redeemed for the physical slab (on Collector Crypt's site) or listed on a marketplace.
6. **Web app:** Privy email/passkey sign-in, pack shop, checkout (pay from any chain), the opening reveal, a card page with a proof panel, transfer and sell back.
7. **AI-judge path:**
   - `pnpm demo:testnet` runs NEAR testnet, a Tidepool checkout, Solana devnet and CC devnet end to end, headless. It falls back to fixtures if Tidepool `/v0/health` or CC devnet is down.
   - `pnpm verify:pull <token_id>` re-checks every claim.
   - The README uses "do X → see Y" steps.
8. **One real mainnet run (approval),** recorded with hashes in the README.

### Nice-to-have (in this order, only after the must-haves)

2. A **"pay from any chain" checkout demo page for a non-Mintent merchant**, reusing `packages/checkout`. This answers Illia's "universal checkout" idea and supports a `realworld` entry. Drop it if behind schedule.
4. ~~List and cancel on the CC marketplace.~~ Removed: a listing survives an NFT sale (D-016). Withdraw the card first, then list.
5. Cash-out to any chain via Intents.
6. NEAR Auth passkeys (mainnet approval). EVM-chain CC packs. Hosted demo kept up until 25 Nov.

### Out of scope

Own inventory, own odds, a pricing engine, Magic Eden/Tensor connectors, OutLayer VRF, in-contract user balances.

## Day-by-day plan (re-baselined 8 Nov)

| Day | Goal | Exit criteria |
| --- | --- | --- |
| **Sun 8 Nov** | Contract hardening, checkout, relayer, `demo:testnet` ✅ | Pre-sign attack proven, then fixed (D-015). `packages/checkout`, `services/relayer` and the demo pass on real networks. |
| **Mon 9 Nov** | Tier 1 evidence and app start | `verify:pull` run against recorded pulls, evidence file with transaction links, README first draft. Web app: pack shop and checkout against the relayer API. |
| **Tue 10 Nov** | Web app | Privy sign-in, reveal, proof panel, transfer, sell back, withdraw, honest progress messages for slow signing. Needs your Privy app id. |
| **Wed 11 Nov** | Mainnet prep | Mainnet treasury and nonce accounts, a paid RPC endpoint, partner key, dry-run CC mainnet `generatePack` through `assertSafePackTx` with no signing, the contract deploy **(your approval)**. |
| **Thu 12 Nov** | **Mainnet run (your approval, ~$130–180 outlay)** | One real $50 pull paid from SOL, handover, sell back, withdraw, recorded hashes. A spare half-day for fixes. |
| **Fri 13 Nov** | README and video | Final README for machine readers, demo video, X post draft. Features freeze at 18:00. |
| **Sat 14 Nov** | Submit | Final clean-clone run. You make the repo public and post; I print the payload, you confirm, I submit, well before 23:59 UTC. |

### Decision points

- **Durable nonces (adopted 5 Nov, D-011):** every Solana transaction Mintent builds uses the treasury's durable nonce. CC-built partially signed transactions (purchase, `/api/buyback`) can't, so on expiry the relayer requests a fresh transaction and retries (unpaid packs simply expire).
- **MPC latency:** resolved. Measured 12–46 s per signature and 40–71 s for two. CC purchases retry on expiry (1 of 4 needed a retry); everything we build uses durable nonces (D-011); sell-back uses `cc_buyback` quotes (D-013). No hot key needed.
- **6 Nov 18:00, Blocker 1:** resolved 5 Nov. Core transfer from the derived address works; mainnet prizes are Core, so pNFT is out of scope (D-012).
- **7 Nov, CC devnet or Tidepool unavailable:** build against recorded fixtures and a mock server for the AI-judge path. The mainnet run remains the proof.
- **Testnet token mismatch (fixed rule):** Tidepool's devnet USDC (`7paf…r4Xr`) ≠ CC's devnet USDC-Dev. On testnet the treasury is pre-stocked with USDC-Dev, and the checkout settlement is recorded but not spent. On mainnet both are real USDC and the checkout payment funds the pack. The README states this.
- **11 Nov 20:00, mainnet run failed:** fix it on the 12th. If it's still blocked, submit with the testnet demo plus whatever mainnet steps worked, labelled honestly.

### Decisions still open (yours)

0. **Franchise art on the home page.** The gallery wall shows real cards, so franchise art and names printed on slabs are visible, which sits close to your "no franchise branding in our own UI" rule. It's the cards' own media, loaded live, with nothing shipped or named by us. Recommendation: keep it for the hackathon and get legal advice before any public launch.

1. Confirm the design above (front end to CC plus card-account NFTs). Work since "go" assumes it.
2. Tracks: **`nfts` + `realworld` + `open`** is my recommendation (`realworld` is justified by the reusable checkout). `games` is not recommended.
3. Mainnet budget (~$130–180 by 11 Nov) and the source chain (SOL recommended, D-021).
4. Mainnet payout account, Privy app id, 1Click partner key application, a paid RPC endpoint.
5. Neutral pack names in our UI.

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
├─ apps/web/               # React + Vite + Privy + near-api-js 7
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
| **Privy, direct** | Mainnet email or passkey sign-in with no approval queue (D-026). |
| **SQLite in the relayer** | Durable order state and idempotency with zero infrastructure. |
| **No OutLayer in the must-haves** | CC's ECVRF already proves fairness. OutLayer's TEE-signature "VRF" would be weaker and duplicative. |
