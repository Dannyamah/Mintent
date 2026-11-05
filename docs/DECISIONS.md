# Mintent: Decision Log

This log records only decisions that change or affect the build. Newest decisions are at the top. Each entry gives the date (UTC), the decision, the reason, its impact, and its status:

- **Adopted:** in effect.
- **Provisional:** assumed, awaiting your confirmation.
- **Pending:** your call.
- **Superseded:** replaced by a later entry.

Details live in `PLAN.md`, `CONTEXT.md` and `RESEARCH-FINDINGS.md`.

---

### D-011 · 5 Nov · Mintent-built Solana transactions use a durable nonce; CC-built ones retry on expiry

- **Why:** devnet's blockhash window is about 36 s and MPC latency ranges from 12 s to over 46 s. A transaction needing two MPC signatures (card owner plus treasury fee payer) expired after 35.6 s; the same transfer with a durable nonce succeeded after 39.8 s of signing.
- **Impact:**
  - The relayer keeps a treasury-owned nonce account (seed `mintent-nonce-1`) and prepends `nonceAdvance` to every transaction it builds (transfers, withdrawals, `cc_buyback`, faucet).
  - CC's partially signed transactions (purchase, `/api/buyback`) can't use nonces, so the relayer requests a fresh one and retries on `Blockhash not found`.
  - Buybacks prefer `cc_buyback` quotes (600 s), which we build ourselves.
  - With one nonce account, transactions are serialised. Add more nonce accounts (seeds `-2`, `-3`, …) if throughput needs it.
- **Status:** Adopted.

### D-010 · 5 Nov · Contract redeployed as `app2.mintent-dev-mw21w9ki.testnet`

- **Decision:** the testnet contract moves to `app2.mintent-dev-mw21w9ki.testnet`. `app.` is retired.
- **Why:** adding `order_id` deduplication changed the contract's stored data layout, so the old account's state can't be read by the new code.
- **Impact:** scripts and `.env` point to `app2`. Treasury and card addresses are re-derived, because they depend on the contract account.
- **Status:** Adopted.

### D-009 · 5 Nov · Track entry: `nfts` + `realworld` + `open`; drop `games`

- **Why:** `nfts` matches card-account NFTs word for word. `realworld` names "merchant payments", which the reusable checkout covers. `games` is judged on a game loop we don't have.
- **Impact:** the standalone merchant checkout page becomes nice-to-have #2.
- **Status:** Pending (your call; submission field `tracks`).

### D-008 · 5 Nov · Tidepool is the testnet 1Click backend, with a fixture fallback

- **Why:** NEAR Intents has no official testnet. Tidepool is 1Click-compatible (same `/v0` API and SDK) on NEAR testnet.
- **Impact:**
  - `packages/checkout` gets three backends: mainnet, Tidepool and mock.
  - `pnpm demo:testnet` uses Tidepool.
  - Rules: test tokens only, never send it our partner JWT, never rely on swap hashes.
  - Testnet rule: Tidepool's devnet USDC ≠ CC's devnet USDC-Dev, so the treasury is pre-stocked with USDC-Dev on testnet.
- **Status:** Adopted.

### D-007 · 5 Nov · One checkout per pack; no user balances in the contract

- **Why:**
  - It matches Illia's "universal checkout" idea.
  - It removes custody of user funds and a balance ledger from the contract.
  - On mainnet the payment lands as Solana USDC at the treasury, which is exactly what CC charges.
- **Impact:** `mint_pack(order_id, …)` mints once per paid order (`order_id` = 1Click deposit address). The prepaid-balance design is dropped.
- **Status:** Adopted (implemented and tested).

### D-006 · 4 Nov · The purchaser is the contract's MPC treasury key; hot key only as a fallback

- **Why:** measured MPC signing through the contract took 12.3–13.6 s, inside CC's ~30 s window for its partially signed transactions.
- **Impact:** we switch to a hot purchaser key (cards still delivered to MPC card addresses) only if more than 1 in 5 purchases miss the window. Buybacks fall back to `cc_buyback` quotes (600 s).
- **Status:** Adopted.

### D-005 · 4 Nov · Sign-in with Privy (via near-connect), not NEAR Auth

- **Why:** NEAR Auth mainnet needs approved Auth0 credentials. Privy works on mainnet without an approval step.
- **Impact:** NEAR Auth becomes nice-to-have.
- **Status:** Adopted.

### D-004 · 4 Nov · Liquidity through Collector Crypt's own APIs, not Magic Eden or Tensor

- **Why:** CC's marketplace, gacha and metadata APIs need no key and have devnets. Magic Eden and Tensor transaction endpoints need keys you apply for.
- **Impact:** Magic Eden and Tensor connectors are out of scope.
- **Status:** Adopted.

### D-003 · 4 Nov · Fairness comes from CC's on-chain ECVRF; OutLayer VRF dropped

- **Why:** CC already runs a public RFC 9381 ECVRF. OutLayer's VRF is a TEE-held Ed25519 signature, which is weaker.
- **Impact:** OutLayer is out of the must-haves. The proof panel links to CC's verifier.
- **Status:** Adopted.

### D-002 · 4 Nov · Each pull is a NEP-171 card-account NFT on NEAR

- **Decision:** each token controls its own Chain Signatures Solana address (`card/<token_id>`).
- **Why:** the `nfts` track asks for "NFTs as accounts … hold inventory". The rundown had no NEAR NFT.
- **Impact:** only the token owner can make the contract sign for its card, and transferring the token moves control. This is the core of the contract.
- **Status:** Adopted.

### D-001 · 4 Nov · Pivot: NEAR front end to Collector Crypt packs instead of our own packs

- **Why:**
  - CC's packs already give an expected value of 101–110% of the price with 85–93% buyback, and have public provable fairness.
  - Our own packs (at 95% expected value) would be worse for users, need capital, and carry more legal risk.
- **Impact:** no inventory, odds or pricing engine of our own. The build is CC's keyless APIs plus Chain Signatures plus Intents.
- **Status:** Provisional. You said "go" on a plan built on this; explicit confirmation is still pending.
