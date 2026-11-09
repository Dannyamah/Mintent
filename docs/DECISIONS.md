# Mintent: Decision Log

This log records only decisions that change or affect the build. Newest decisions are at the top. Each entry gives the date (UTC), the decision, the reason, its impact, and its status:

- **Adopted:** in effect.
- **Provisional:** assumed, awaiting your confirmation.
- **Pending:** your call.
- **Superseded:** replaced by a later entry.

Details live in `PLAN.md`, `CONTEXT.md` and `RESEARCH-FINDINGS.md`.

---

### D-030 · 9 Nov · Mainnet accounts created; a real purchase passes the safety check

- **Accounts (you created them, 9 Nov):** contract `mintent.xinju.near` (3.5 NEAR), relayer `relayer.xinju.near` (1.5 NEAR), both funded from `xinju.near`. Their keys are in `~/.near-credentials/mainnet/` and match the chain. The contract isn't deployed yet.
- **Addresses these names lead to:** treasury `A5SBNb1f6ECxXLWDoHk2onu6YdNuSjdeANAxYXqJj1k5`. Derived, so they change if the contract's name changes.
- **Purchase check:** `scripts/src/mainnet-pack-check.ts` got a real unsigned $25 purchase from Collector Crypt, and `assertSafePackTx` passed it. Nothing was signed or sent. The transaction has Collector Crypt as fee payer, with no lookup tables.
- **Deployed (your approval, 9 Nov):** the same code as the tested testnet contract, hash `CaVHH4mYkqTBG2BC2Tn2ih3ie8KKAdT8YdoYNx2aBwsS`, deploy tx `AqCcPnmiodXsCZ5hxMhBUSTJ2etBHZbstdLjxuoL9eNm`, init tx `G8vaWRqVgePM4LhVRFnYfwbjFzGhnYY7RAa9mYAYpPwZ`. `owner_id` is `xinju.near`, relayer is `relayer.xinju.near`.
- **Still to do:** the owner must add the USDC mint and nonce accounts, and the treasury needs SOL. Removing the full-access key is still your decision, and hasn't been done.
- **Status:** Adopted.

### D-029 · 9 Nov · The app checks every message before signing; payment proof no longer needs a reported hash; mainnet demo uses the $25 pack

- **Signing check:** the wallet's signing function parses the Solana message and refuses unless it does exactly what the owner asked, with the destination they typed. No screen can skip it. It reads the NFT's owner, card, addresses and Mintent's nonce accounts from NEAR through pinned RPCs, not from the relayer. It refuses lookup tables, extra steps and anything it can't fully read. The sell-back price on screen now comes from the message itself.
- **Pinned contract:** `VITE_MINTENT_CONTRACT` fixes the contract at build time. **A mainnet build refuses to sign without it.** A testnet build may follow the relayer, so anyone can run the demo.
- **Cash-out quotes:** the app checks the quote names the recipient, coin, amount and refund address, and on mainnet that 1Click signed it. BTC is the exception, because the SDK rejects 1Click's own BTC quotes. Limits are in `THREAT-MODEL.md`.
- **Payment proof fallback:** 1Click's docs don't say whether a confidential swap reports the payout hash. If the reported hash doesn't prove payment, the relayer looks for one transaction on the treasury's USDC account, since the order began, for at least the full amount, that no other order has claimed. It still needs 1Click to say SUCCESS. Each transaction can pay for one order only. It found the right transaction for 6 of 6 recent real orders on devnet. **Whether mainnet reports the hash is still unknown, and the mainnet run will show it.**
- **Budget (your call):** the mainnet demo uses the $25 pack instead of $50, and `pokemon_25` is now the mainnet default. You asked for $30. My estimate is about $40, because deploying the contract costs about 3 NEAR in storage. **Still needs your decision.**
- **RPC:** a paid plan isn't needed for the demo. Helius's free tier lists archival data, and NEAR has free public RPCs.
- **Status:** Adopted.

### D-028 · 9 Nov · Design confirmed; any-chain payment, cash-out to any chain, and email or wallet sign-in

- **Your decisions:** pay from any chain, NFT on NEAR, card on Solana, cash out to any chain. Users sign in with email or connect a wallet they already have. This confirms D-001.
- **Wallet sign-in:** through Privy. A connected wallet (MetaMask, Coinbase Wallet, Rainbow and others) is the login, and Privy holds the key of a NEAR account that owns the NFTs. The wallet doesn't own the NFT, and the app says so. Phantom needs Solana wallet login turned on in the Privy dashboard. Wallets native to NEAR (HOT, Meteor) aren't supported, which would need near-connect.
- **Sign-out:** every account type can sign out. Signing out of a test account keeps its key, because that's the only copy.
- **Cash-out:** the NFT's USDC pays a 1Click deposit address from the NFT's own Solana address, and the swap pays out on the chosen chain. A refund returns to the NFT's address, so it stays with whoever owns the NFT. The owner sees the amount, coin, chain and recipient before signing. USDC on Solana skips the swap. The card itself stays on Solana: withdrawing it still needs a Solana address.
- **Testnet differs in one way:** sell-back money is Collector Crypt's USDC-Dev, which Tidepool doesn't accept. So on testnet it goes to the treasury, and the treasury funds the deposit in Tidepool's USDC, with refunds going to the treasury. **The mainnet transaction shape has only been unit-tested, and needs proving on the mainnet run.**
- **Payment:** the testnet app now offers Tidepool's real chains. Refund addresses are checked per chain before any quote. The checkout handles underpayment and expired quotes. API errors reach customers as plain messages.
- **USDC on Solana as a payment:** Tidepool refuses to swap a coin for itself, so it's hidden on testnet. Mainnet 1Click quotes it (about 1% cost, dry quote on 9 Nov), so it stays on mainnet, unproven with real money.
- **Trust:** the relayer builds every message an owner signs. That gap is closed by D-029.
- **Status:** Adopted.

### D-027 · 9 Nov · Stuck paid orders recover by themselves

- **Why:** an order went to `needs_attention` after 12 failed attempts, and with a 5 s loop that's about a minute. A short RPC, Collector Crypt or treasury outage would have stranded a paid mainnet order for good.
- **Decision:** the relayer retries stuck orders every 5 minutes for 24 hours, 3 attempts each round. After that, only "Try again now" restarts them. That button is on checkout and the dashboard, with a 60 s cooldown. Refunded and rejected orders are final.
- **No repeated effects:** the resume point comes from what the order already recorded. Payment is proven on-chain again, the contract refuses a second mint, and the old purchase is checked before any new one.
- **New guard:** a retry can come long after the purchase, when an RPC may have pruned its signature. Collector Crypt is now asked whether the pack was paid for before the relayer pays again.
- **Treasury SOL guard:** the devnet treasury was found holding 0.0012 SOL with nothing watching it, which would have stalled the next order. New orders are now refused, before any payment, when it holds under 0.005 SOL, and the relayer logs it. Only new orders are protected; mainnet still needs someone keeping the treasury funded.
- **Impact on mainnet:** after 24 hours an order still needs a human, and there's no automated refund yet. Mainnet needs an RPC that keeps signature history.
- **Status:** Adopted.

### D-026 · 9 Nov · Privy directly, without near-connect

- **Decision:** the web app calls Privy's SDK directly (`@privy-io/react-auth` 3.51.3, `createWallet({ chainType: "near" })`, `useSignRawHash`). This replaces the "via near-connect" part of D-005.
- **Why:** NEAR's guide recommends direct Privy for a web-style app with social login. near-connect would add a wallet manifest, a separate signing page and a client ID, and its only gain is third-party wallets, which Mintent's buyers don't need.
- **Email only (your call, 9 Nov):** no passkey option. This also drops the passkey part of D-005. Wallet sign-in was added later the same day (D-028).
- **Impact:** Keys are held by Privy, and users can export them from the account menu. The test account stays on testnet only and is refused on mainnet. The SDK loads as a separate 399 kB (gzipped) chunk, so it doesn't delay the shop.
- **Before mainnet:** turn off Privy test accounts, because their fixed login code would let anyone sign in to them, and restrict allowed domains.
- **Status:** Adopted. Proven on testnet with a real login and live signing (see `EVIDENCE.md`).

### D-025 · 8 Nov · Frontend rebuilt: dashboard, pack ceremony, real numbers only; test treasury refills itself

- **Decision (your request):** the app was rebuilt with motion, depth and shadows, and now has a dashboard, a tap-to-tear pack opening, pack detail pages, a security page, an account menu, toasts, skeleton loading, a FAQ and a not-found page. It's still React + Vite, with `motion`, `lucide-react` and `uqr` added.
- **Rule:** every dashboard number is read live from NEAR, Solana or Collector Crypt. There are no invented charts or estimates. Vault value is labelled as insured value, not a market price.
- **Sell-back copy doesn't state a fixed window.** Collector Crypt's docs say 72 hours, but devnet returned a 30-day deadline, and 8 of 8 recent mainnet pulls returned `available: false` when checked read-only. The UI says "limited time" and shows the live deadline from the API. **Check real sell-back availability during the mainnet run.** If new pulls can't be sold back straight away, the pitch and reveal copy need to change.
- **Testnet treasury top-up:** a browser run stalled because the treasury ran out of devnet USDC-Dev. Testnet payments settle in a different mint, so that balance only drains. The relayer now refills it from the devnet faucet when it's under 100. That code doesn't exist on mainnet, where the buyer's payment funds the purchase.
- **Known gap, closed by D-027:** an order that reached `needs_attention` had no retry path.
- **Status:** Adopted.

### D-024 · 8 Nov · The relayer sponsors NEAR gas for anyone holding a token

- **Why:** someone given an NFT with no NEAR couldn't act on their own card. NEAR checks balance at about 10x the gas price against prepaid gas (measured on testnet: 30 Tgas needed 0.0309 NEAR), so a small fixed amount failed.
- **Impact:** the relayer tops up an account when it pays for an order or starts an action on a token it owns, sized from the live gas price. The float is about 0.1 NEAR per new user at testnet's gas price and mostly stays in their account. **That's real money on mainnet relative to a 1% fee, so check it against the mainnet gas price on 11 Nov.** Meta-transactions would remove it, but they're out of scope for the hackathon.
- **Status:** Adopted.

### D-023 · 8 Nov · Frontend: gallery hero (your choice), React + Vite, browser key on testnet

- **Decision (yours):** the home page uses the "gallery" concept from the reel you sent: a wall of work framing the headline. **I could only read the reel's caption and thumbnail, not the video.**
- **Why:** real pulled slabs are the most persuasive thing we can show, and the wall is live data, not stock art.
- **Impact:**
  - The wall shows recent real pulls from Collector Crypt's public feed, loaded at runtime. No card art ships in the repo, and tiles are labelled by grade and value only.
  - Vite instead of Next.js: there's no server rendering to gain from, and it deploys as static files.
  - On testnet, sign-in is a key generated in the browser, with no seed phrase or popup. **Mainnet needs Privy** before real users can sign in.
- **Status:** Adopted. Whether franchise art on the home page is acceptable for a public launch is an open question (see PLAN.md).

### D-022 · 8 Nov · No Collector Crypt partnership, keys or contact during the build

- **Decision (yours, stated before the build):** Mintent is built entirely on CC's public, keyless APIs. Any partnership comes after the full build.
- **Why:** the product must work without anyone's permission.
- **Impact:**
  - In-app redemption and the Invoiced API are out of scope, along with `partnerSlug` and CC API keys.
  - **Withdraw to the owner's own wallet is now a must-have:** that's how a card is redeemed on CC's site or listed on a marketplace.
  - CC's anonymous rate limits apply, which is ample for a demo.
  - Rev share (D-017) is a post-hackathon idea only.
  - The README must say plainly that Mintent isn't affiliated with Collector Crypt and uses its public APIs.
- **Status:** Adopted.

### D-021 · 8 Nov · Mainnet demo pays from SOL live; BTC is a recorded clip

- **Why:** a mainnet dry quote estimates **802 s (about 13 minutes)** for BTC, against 17–42 s for SOL, NEAR USDC, Base, Arbitrum and ETH.
- **Impact:** the video shows a real SOL (or Base USDC) payment end to end, plus a clip of a real BTC deposit if the budget allows. Don't promise "under a minute" from BTC.
- **Status:** Provisional (your budget and chain call).

### D-020 · 8 Nov · Judges verify in tiers, and the core tier needs no credentials or faucet

- **Why:** an AI judge has no credentials of ours, and **Tidepool made its faucet site-only on 8 Nov**, after tightening it on each of the previous days. A judge's automated path can't depend on it.
- **Impact:**
  - **Tier 1 (no credentials, minutes):** `pnpm test`, `pnpm verify:pull` on our recorded real pulls (public data only), and the mainnet dry-quote check.
  - **Tier 2 (test tokens):** `pnpm demo:testnet` creates its own accounts, deploys `contracts/res/mintent.wasm` and funds its own treasury. It needs a `DEMO_FUNDER` account holding test USDC from Tidepool's site.
  - **Tier 3:** the video and the hosted app.
- **Status:** Adopted.

### D-019 · 8 Nov · Multiple NEAR RPC providers with backoff; never `rpc.*.near.org`

- **Why:** `rpc.testnet.near.org` is deprecated and returned 429 during the demo. FastNEAR's free endpoint then rate-limited us per IP too.
- **Impact:** `nearProvider()` fails over across several endpoints, and `NEAR_RPC_URLS` puts paid ones first. **For the mainnet run and judging week, use a paid or private RPC endpoint.**
- **Status:** Adopted.

### D-018 · 8 Nov · Settlement is proven on Solana, not taken from the API

- **Why:** a "SUCCESS" string is an API's claim. Also, the official SDK's `verifyQuoteSignature` returns **false for 1Click's own BTC quotes** (live and dry; SOL and ETH verify), so signatures alone would have blocked the headline flow.
- **Impact:**
  - The relayer checks the quote's recipient, asset and amount, then reads the destination transaction and confirms the treasury's balance rose by at least the order amount.
  - Each settlement transaction can pay for only one order.
  - Signature checks stay strict everywhere except BTC, which is a documented false negative worth reporting to the Intents team.
- **Status:** Adopted.

### D-017 · 8 Nov · A 1% service fee inside the quote instead of `appFees`

- **Why:** `appFees` gives up half and forces a 20 bps minimum to 1Click. A stablecoin route costs 1 bp without it, and an EXACT_OUTPUT quote for price + 1% pays for Solana fees and rent directly into the treasury.
- **Impact:** the customer sees pack price + 1% before paying. This replaces the rundown's pack edge and buyback spread as the revenue line. Real margin on a $50 pack is about $0.50 minus roughly $0.30 of Solana costs, so this is a distribution business that needs a Collector Crypt rev share to be meaningful. The Invoiced API has one.
- **Status:** Adopted.

### D-016 · 8 Nov · Marketplace listing is not available through the token; withdraw first

- **Why:** a listing installs a delegate that survives an NFT sale, so a seller could list cheaply to their own alt account, sell the NFT, then buy through the listing. S2 proved listing works, but it can't be made safe at the token level in the time we have.
- **Impact:** supersedes the marketplace item in the plan and the S2 route. To list, the owner withdraws the card to their own Solana wallet, which releases the token. Also, D-013's standard `/api/buyback` fallback is dropped: its CC-built transaction isn't policy-checked and isn't needed.
- **Status:** Adopted.

### D-015 · 8 Nov · The contract parses and restricts what it signs, and locks tokens after signing

- **Why:** we proved on a live deployment that "only the current owner can sign" is not enough: a seller signed a transfer, sold the NFT, then broadcast it, and the buyer got an empty NFT (devnet tx `287sh1C2…`). Delegates and durable nonces give the same result.
- **Impact:**
  - `sign_for_card` accepts only messages on a strict allowlist (`contracts/mintent/src/solana.rs`).
  - Every card signature locks NFT transfer for 5 minutes, and a card-moving signature puts the token in `Exiting` until the outcome is recorded.
  - Durable nonces are limited to Mintent's own accounts, which also need the treasury's signature.
  - New contract: `docs/THREAT-MODEL.md` documents all of this.
- **Status:** Adopted. Replaces the earlier idea that the contract "does not interpret Solana transactions".

### D-014 · 5 Nov · The relayer reconciles NEAR card records against Solana ownership

- **Why:** the contract can't see Solana. In S1 a card left token 0's address without `record_release`, so NEAR said "Opened" while Solana said otherwise.
- **Impact:**
  - Every relayer flow that moves a card calls `record_release` in the same job.
  - A reconciler (and `pnpm verify:pull`) compares `get_card` with the on-chain asset owner and flags or fixes drift.
  - The UI shows a card as held only when both agree.
- **Status:** Adopted.

### D-013 · 5 Nov · Sell-back goes through the signed-quote route (`cc_buyback`), with proceeds landing in the NFT's own address

- **Why:**
  - It's the only route we build ourselves, so it uses the durable nonce. The quote lives 600 s, so slow MPC signing (up to 71 s) is fine.
  - It pays into the card's own address, which the NEP-171 holder controls. The NFT literally "owns money" until the holder withdraws it to any address (or chain, via Intents).
  - The standard `/api/buyback` (CC pays the fee, ~36 s window, supports `altRecipient`) is the fallback.
- **Impact:** exit flow = sell back → proceeds sit in the card account → owner withdraws (two signatures, durable nonce). The UI and README describe proceeds as held by the NFT.
- **Status:** Adopted (both routes verified on devnet).

### D-012 · 5 Nov · v1 supports Metaplex Core cards only; pNFT deferred

- **Why:** all 15 sampled mainnet $50/$100 prizes and every devnet prize were Core. pNFT transfers need Token Metadata, rule sets and lookup tables, which is days of work for cards we won't get.
- **Impact:**
  - Relayer and UI handle `core`.
  - Any other standard is shown as "withdraw only via Collector Crypt" and the transfer is blocked.
  - The pNFT decision point in PLAN.md is retired.
- **Status:** Adopted.

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
  - **Update 8 Nov:** Tidepool's faucet is now site-only (D-020), so it's for development and Tier 2, not the judges' automated path. It has changed its limits daily, so expect further changes.
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
