# Mintent: Context (source of truth)

Last full verification: **4 Nov 2026**. Each fact is marked:

- **[V date]**: verified against the linked primary source on that date.
- **[A]**: assumption or judgment, not verified.

When a source and this file disagree, the source wins. Update this file and log the change in `RESEARCH-FINDINGS.md`.

---

## 1. Hackathon facts

Sources: https://nearhackathon.com/HACKATHON.md and https://nearhackathon.com/ [V 4 Nov]

| Item | Fact |
| --- | --- |
| Build window | 1 Nov 00:00 UTC to 14 Nov 23:59 UTC. Code written since the announcement on **19 Oct 2026** counts (Q-001). [V 4 Nov] |
| Submission deadline | **14 Nov 2026 23:59 UTC**. The repo must be public by then. Submissions can't be edited. [V 4 Nov] |
| Judging / results | Judging 16–18 Nov; results by 18 Nov 23:59 UTC. Payout in NEAR within 30 days, in a single payment. [V 4 Nov] |
| Prizes | $250K pool: $55K grand prize, plus $10K / $3K / $2K for 1st–3rd in each of 13 tracks. Amounts are fixed in USD and paid in NEAR. [V 4 Nov] |
| Submission | One per project, with multiple tracks allowed. POST https://nearhackathon.com/api/applications or the form at /#apply. Fields: requestId, projectName, leadName, email, size, tracks[], nearAddress (mainnet), projectUrl (unique per repo), demoUrl (the X post), idea (20–2000 chars), consent. Max 2 submissions per email. 403 outside the window. [V 4 Nov] |
| Required | Public repo with a README a machine can follow, a **LICENSE file**, and disclosure of pre-hackathon code, libraries and templates. Public X post saying it was built at NEAR HACKATHON, tagging @NEARProtocol and #NEARHackathon, with a video (screenshots alone are not enough if judges can't open the demo). [V 4 Nov] |
| Hosted demo | A plus. Keep it up until 18 Nov, ideally 25 Nov (Q-012). [V 4 Nov] |
| AI judges | Claude Code and Codex **screen only**: a reproducibility check, feature verification, a structured report and a preliminary score. Humans decide. A low AI score alone can't reject a project (Q-017). [V 4 Nov] |
| Mandatory integrations | None. Our own NEAR contract that fits the track is enough (Q-011). Testnet-only projects are eligible, but Intents is mainnet-only (Q-007, Q-010). [V 4 Nov] |
| Intents during the hackathon | No testnet exists or is planned. Use mainnet with separate dev accounts, tiny amounts and `dry: true` quotes (Q-007). [V 4 Nov] |
| Mainnet costs | Not reimbursed (Q-008). [V 4 Nov] |

**Our rules, set by the user:** no submission, X post, mainnet transaction, spending, deployment or public repo without the user's explicit approval. No Pokémon or other franchise branding in our own UI or assets. Card art appears only as the card's own NFT media.

### Tracks (all 13, ids for the API)

`defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open` [V 4 Nov]

- **`nfts`, NFTs That Do Something:** "Build NFTs as accounts — assets that own money, earn royalties, hold inventory, carry credentials, memberships or access rights. Ownership with behavior." Hints: Dynamic NFTs, NEP-171, sub-accounts. Example prompt: https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/10-nfts.md [V 4 Nov]
- **`games`, Games With Real Economies:** "Judged on the game loop, not the token — bonus if players never notice the chain." Hints: agent NPCs, social login, NEAR Intents, NEP-245. [V 4 Nov]
- **`open`, Open Innovation:** experimental and chain abstraction. [V 4 Nov]
- **Track fit (judgment) [A]:** `nfts` is the best fit, if our NFT lives on NEAR and acts as an account (see section 4). `games` is a weak fit, because packs are not a game loop. `open` costs nothing to add. The AI-agent tracks (`agents`, `business`, `swarms`, `security`) are likely the most crowded, given the event's "programmable money / agents" theme.

### Judges

Illia Polosukhin (NEAR), Eddy Lazzarin (a16z crypto, GP since May 2026), Mert Mumtaz (Helius), Avichal Garg (Electric Capital), Kain Warwick (Synthetix / Infinex), Haseeb Qureshi (Dragonfly), Stepan Gershuni (cyber•Fund), plus Claude Code and Codex for screening. [V 4 Nov, site]

Per-judge notes are in `RESEARCH-FINDINGS.md` section 6.

### Ecosystem partners (16)

NEAR Intents, Aurora, HOT, Rhea, meme.cooking, HEX, NEAR.AI, SVRN, Trezu, SputnikDAO, OutLayer, GoMining, Agent Market, NEAR Builders, Gulf Labs, BRRRAIN. [V 4 Nov]

Relevant to Mintent [A]:

- **NEAR Intents:** core.
- **HOT:** its `@hot-labs/near-connect` is NEAR's documented wallet connector.
- **OutLayer:** optional. Credit it if used.
- **NEAR Builders:** $10 of NEAR AI credits. Not needed.

---

## 2. NEAR building blocks (current versions and facts)

### 2.1 Contracts, tooling and testing

Versions are from crates.io and npm.

| Package | Latest | Released | Status |
| --- | --- | --- | --- |
| `near-sdk` (Rust) | 5.30.0 | 2026-10-27 | [V 4 Nov] |
| `cargo-near` | 0.22.0 | 2026-10-19 | [V 4 Nov] |
| `near-workspaces` (Rust) | 0.24.0 | 2026-10-26 | [V 4 Nov] |
| `near-sandbox` (Rust) | 0.4.0 | 2026-10-26 | [V 4 Nov] |
| `near-api` (Rust) | 0.8.7 | — | [V 4 Nov] |
| `omni-transaction` (Rust, builds foreign-chain transactions) | 0.5.0 | — | [V 4 Nov] |
| `near-api-js` | 7.4.0 | 2026-10-23 | [V 4 Nov] |
| `@hot-labs/near-connect` | 0.12.0 | 2026-10-26 | Now the wallet connector used in docs.near.org. `@near-wallet-selector/core` was last released 2025-12-04. [V 4 Nov] |
| `chainsig.js` | 1.1.16 | — | [V 4 Nov] |
| `@solana/kit` | 8.6.0 | — | [V 4 Nov] |
| `@solana/web3.js` | 3.1.1 | — | [V 4 Nov] |
| `@defuse-protocol/one-click-sdk-typescript` | 0.1.26 | — | [V 4 Nov] |
| `@defuse-protocol/intents-sdk` | 0.94.0 | — | [V 4 Nov] |
| `outlayer` (Rust SDK for WASI modules) | 0.2.1 | — | [V 4 Nov] |

- **Breaking changes since late October:** none found in the docs I read. I did not read the near-sdk 5.30 changelog line by line. [A]
- **Testing:** the real MPC contract is not in the sandbox, so contract tests need a **mock signer contract** that exposes the same `sign` interface. [A, standard practice]

### 2.2 Chain Signatures

Docs:

- https://docs.near.org/chain-abstraction/chain-signatures
- https://docs.near.org/chain-abstraction/chain-signatures/implementation
- Contract README: https://github.com/near/mpc/blob/main/crates/contract/README.md

Facts:

- **MPC contract ids:** mainnet `v1.signer` (version 3.17.0, read on-chain), testnet `v1.signer-prod.testnet` (version 3.18.0). [V 4 Nov, RPC `version` view]
- **Domains:** `domain_id: 0` is Secp256k1/ECDSA; `domain_id: 1` is **Ed25519/EdDSA**, which covers Solana. Domain 2 is BLS12-381, used for confidential key derivation. [V 4 Nov]
- **Mainnet Ed25519 root key:** `ed25519:G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF`. Testnet: `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2`. [V 4 Nov, `public_key {"domain_id":1}`]
- **Sign request:**

  ```json
  {"request":{"payload_v2":{"Eddsa":"<hex>"},"path":"<string>","domain_id":1}}
  ```

  The EdDSA payload must be **32–1232 bytes**, which is the full serialized Solana message, up to Solana's packet limit. [V 4 Nov]
- **Cost per signature:** a deposit of **1 yoctoNEAR** (any excess is refunded) plus **≥10 Tgas attached (~7 Tgas used)**. That is roughly 0.0007 NEAR of gas. [V 4 Nov, README]
- **Deposit rule:** because the deposit is required, a function-call access key can't call `sign` directly unless it has a deposit allowance. A contract calling `v1.signer` is fine. [V 4 Nov]
- **Derivation:** additive key derivation from (predecessor account, path, domain). `derived_public_key(path, predecessor, domain_id)` is a view method. A Solana address is the derived Ed25519 public key. [V 4 Nov]
- **Latency per signature:** not documented. **Measured on testnet 4 Nov: 11.7 s median direct, 12.3–13.6 s through our contract** (n=5). [V 4 Nov, our spike]
- **Duplicate requests:** identical pending requests are queued and share one response. The queue is bounded (`PendingRequestQueueFull`). [V 4 Nov]
- **`verify_foreign_transaction`:** exists, costs 1 yocto plus 10 Tgas, and has at most 32 extractors. It could let our contract verify a Solana transaction. Which foreign chains are enabled is **unknown**: no view method was found, and the chain set depends on MPC node configs. Treat it as a nice-to-have only. [V exists 4 Nov / A availability]
- **Live network status:** https://mpc.nearone.org

### 2.3 NEAR Intents and the 1Click API

Docs: https://docs.near-intents.org (index: /llms.txt; changelog: /changelog/overview)

- **Base URL:** `https://1click.chaindefuser.com/v0/...`. OpenAPI spec: https://1click.chaindefuser.com/docs/v0/openapi.yaml [V 4 Nov]
- **Coverage:** `GET /v0/tokens` returns **215 tokens on 38 chains**, including native BTC (`nep141:btc.omft.near`), Solana USDC (`nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`), SOL, and NEAR-native USDC. [V 4 Nov, live call]
- **Fees** (https://docs.near-intents.org/resources/fees) [V 4 Nov]:

  | Case | Fee |
  | --- | --- |
  | Protocol fee | 0.0001% |
  | No API key | +25 bps on every non-ANY_INPUT quote, on top of any `appFees` |
  | With API key (JWT from https://partners.near-intents.org) | 20 bps by default; 1 bp on USDC/USDT/DAI pairs and same-asset routes |
  | With API key and `appFees` | Split 50/50, with 1Click's half at least 20 bps |
  | Cap | Total app plus 1Click fee ≤ 500 bps |

  HACKATHON.md says "0.2% without JWT". The fee docs say 25 bps. **The docs win.**
- **`appFees`:** `[{recipient, fee}]`, where `fee` is in bps, is charged from the input token, and the recipient is any NEAR address. [V 4 Nov]
- **Since 27 Oct 2026, 1Click swaps are confidential only.** The API is unchanged. `swapDetails.nearTxHashes` lists only the public shield and unshield transactions. **The swap itself settles on the NEAR Private Shard and has no public hash.** [V 4 Nov, changelog]
- **Temporary minimums:**
  - Swaps under **$1,000** from one external chain to another are blocked on BSC, Polygon, TON, Optimism, Avalanche, Stellar, Monad, XLayer and ADI (since 9 Sep).
  - Swaps under **$100** with a deposit on Tron are blocked (since 14 Sep).
  - Deposits into and withdrawals from Intents are unaffected. **BTC, Solana, ETH, Base, Arbitrum and NEAR are not on the list.** [V 4 Nov]
- **Swap types:** EXACT_INPUT, EXACT_OUTPUT, FLEX_INPUT and ANY_INPUT. `depositType`/`recipientType` can be ORIGIN_CHAIN, INTENTS, DESTINATION_CHAIN or CONFIDENTIAL_INTENTS. Quotes are signed and verifiable (https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature). [V 4 Nov]
- **Explorer API:** https://explorer.near-intents.org/api/v0/openapi.yaml [V 4 Nov, link exists; not exercised]
- **Testnet:** none (HACKATHON.md Q-007). [V 4 Nov]

### 2.4 OutLayer

Docs: https://app.outlayer.ai/docs, full text at https://app.outlayer.ai/llms-full.txt. The old URL outlayer.fastnear.com/docs 301-redirects there. [V 4 Nov]

- **Contracts:** mainnet `outlayer.near`, testnet `outlayer.testnet`. The API is `https://api.outlayer.ai` (testnet `https://testnet-api.outlayer.ai`). Contracts call `request_execution` and get the result in a callback via yield/resume. [V 4 Nov]
- **VRF:**
  - How it works: alpha = `vrf:{request_id}:{sender_id}:{user_seed}`; signature = Ed25519_sign(vrf_sk, alpha); output = SHA256(signature). It is verified on-chain with `env::ed25519_verify`.
  - Public keys: mainnet `419db4f6…5979e3`, testnet `c0c5aeae…f8cfa8`.
  - At most 10 VRF calls per execution.
  - [V 4 Nov]
- **Caveat on the VRF [A]:** this is an Ed25519 signature produced inside a TEE (Intel TDX), not an RFC 9381 VRF. Ed25519 signatures are not unique: a signer could pick a different nonce. So "can't re-roll" relies on trusting the TEE, not on the maths.
- **Pricing:** on-chain `get_pricing` returns `[1e21, 1e14, 1e17, 1e17]` yocto, i.e. a base fee of 0.001 NEAR. Mainnet stats show 2,802 executions and 3.47 NEAR in total fees, averaging about 0.0012 NEAR per execution. The CLI example attaches 0.01 NEAR, and unused deposit is refunded. Stale requests can be cancelled after 10 minutes. [V 4 Nov]
- **Latency:** not documented. [A]
- **Relevance to Mintent [A]:** no longer needed for randomness (see section 3.2). Optional uses: an attested HTTPS read of CC prices, or TEE custody. Not in the must-have scope.

### 2.5 Sign-in

- **NEAR Auth** (formerly FastAuth; https://docs.near.org/web3-apps/tutorials/near-auth):
  - Google, Apple, email or **passkeys**, with keys secured by MPC (`fast-auth.near` plus `v1.signer`).
  - **Mainnet requires approved Auth0 credentials (an application form).** Testnet works without approval.
  - Packages: `@fast-auth-near/react-sdk`, `@fast-auth-near/javascript-provider`.
  - [V 4 Nov]
- **Privy** (https://docs.near.org/web3-apps/tutorials/privy):
  - Email or social login creates a NEAR wallet.
  - Works directly or as a plugin for `@hot-labs/near-connect` (`@peerfolio/privy-near-connect`). Example: https://github.com/near-examples/hello-privy
  - Privy itself supports passkeys. [A: confirm in the Privy dashboard]
  - [V 4 Nov]
- **near-connect** (https://docs.near.org/web3-apps/tutorials/wallet-login): manifest-based wallets, including HOT, Meteor and Intear. [A: exact list loaded at runtime]
- **Web3Auth:** documented as an alternative. [V 4 Nov]

---

## 3. Collector Crypt (CC) and the card market

Primary docs: https://docs.collectorcrypt.com (sitemap: /sitemap.xml). Jupiter Gacha docs: https://docs.jup.ag/user-docs/trade/gacha/

> **Correction to the rundown:** `ccot-docs.pages.dev` is **Collector Crypt on TON (CCoT)**, a separate joint venture on TON. Its "max($3, 1% insured value)" withdrawal fee and its manual withdrawals apply to **CCoT, not Solana CC**. [V 4 Nov]

### 3.1 Chains and standards

- **Chains:** CC NFTs exist on **Solana plus six EVM networks** (Ethereum, Base, ApeChain, Monad, Arbitrum, Robinhood Chain).
  - The EVM contract is `0x1FFd5353aE2F29758B811fa9F9146c1F59E6e9e7` on ETH, Base, ApeChain and Monad.
  - EVM→EVM bridging is live via Chainlink CCIP. **EVM→Solana is not live yet** (devnet only).
  - The in-app marketplace runs on Solana; EVM cards trade on OpenSea.
  - Source: https://docs.collectorcrypt.com/cross-chain [V 4 Nov]
- **Solana token standards in use:** Metaplex **Core**, **pNFT** (Token Metadata with CC's rule set), legacy NFT, and compressed (`cnft-core`, Bubblegum). Each card is its own mint. A sample card (`9CCw…EpH6`) reads `nftStandard: "pnft"`. A pNFT transfer needs a **v0 transaction with an address lookup table** to fit in 1,232 bytes (1,383 bytes legacy vs 1,047 bytes v0). Source: https://docs.collectorcrypt.com/gacha/cc-buyback [V 4 Nov]

### 3.2 Gacha

- **Play API:** https://docs.collectorcrypt.com/gacha/api
  - Base URLs: prod `https://gacha.collectorcrypt.com`, **devnet `https://dev-gacha.collectorcrypt.com`** (devnet USDC faucet: spl-token-faucet.com, USDC-Dev).
  - **The API key is optional on play endpoints.** Without it, requests are treated as unauthenticated and the memo prefix becomes `cc-`. Only `/api/v1/machines` and `/api/v1/stock` return 401.
  - Endpoints: `generatePack` returns a **partially signed transaction** (the player pays USDC), with optional `altPlayerAddress` (card goes elsewhere), `turbo` and `altFundsRecipient`. Then the transaction is submitted (`submitTransaction`). `openPack(memo)` returns the card mint, roll and rarity (poll `WAITING_FOR_WEBHOOK`). Packs must be opened **within 2 hours**; unopened ones are auto-refunded.
  - **The transaction is valid for about 150 blocks (~30 s) from its blockhash, and the blockhash can already be up to 10 s old.**
  - Rate guards: >50 unpaid `generatePack` calls in 10 minutes, or >30 paid-but-unopened packs in 2 hours, returns 429.
  - [V 4 Nov]
- **Live machines** (`GET /api/machines`, 4 Nov):
  - Mainnet packs: $50 (`pokemon_50`, `ghost_50`), $100, $151, $250, $500, $1,000, $2,500, $5,000.
  - Expected insured value is **~101–110% of price** (e.g. `pokemon_50`: EV 54.79). Instant buyback is **85–93%** of insured value.
  - Odds are around common 0.75–0.80, uncommon 0.15–0.20, rare 0.04, epic 0.01.
  - Devnet has $25 packs and is "running". [V 4 Nov, live]
- **Randomness:** CC's own **on-chain RFC 9381 ECVRF (`cc-vrf`) on Solana**. On Solana, alpha = SHA-256("ccgacha-vrf-v1\0" ‖ the player's signature on the pack purchase). Anyone can verify at https://vrf.collectorcrypt.com, `/verify-selection/{memo}` or `GET /api/vrf/verify?memo=`. Source: https://docs.collectorcrypt.com/gacha/vrf [V 4 Nov]
- **Buyback:**
  - Through the API: `/api/buyback` returns a partially signed transaction (~30 s life). Eligibility depends on the NFT, not the caller, but the seller must sign. The window is 72 hours.
  - **`cc_buyback` program:** CC signs a **quote valid for 600 s**. The integrator builds its own transaction: transfer the card, then `authorize_and_pay`. No registration is needed. Program-owned wallets (PDAs) can use it too. [V 4 Nov]
- **Invoiced Partner API** (https://docs.collectorcrypt.com/gacha/invoiced-api):
  - Lets a partner with its own accounts and payments sell CC packs. CC **holds won cards in custody** for the partner's `playerRef`. Buyback and shipping run through the API, with a monthly USDC invoice, a $50K credit line, a rev share and a dev environment.
  - **It needs a CC-issued API key.**
  - **Seed option:** the partner registers an Ed25519 public key and sends `clientSeed` = its signature over the pack memo. Rolls are verifiable at `/vrf/verify`.
  - [V 4 Nov]
- **EVM gacha API:** pay with an ERC-20 lane and an ERC-721 card is minted. Docs show Base Sepolia. https://docs.collectorcrypt.com/gacha/evm-api [V 4 Nov]

### 3.3 Marketplace

https://docs.collectorcrypt.com/marketplace/api

- **No credential is needed.** The user's signature is the authorisation, and an API key only raises rate limits.
- Base URLs: `https://api.collectorcrypt.com`, devnet `https://dev-api.collectorcrypt.com`.
- `POST /marketplace/list|buy|...` returns an unsigned transaction; `POST /marketplace/broadcast` submits it. If the wallet can't pay fees, the platform partially signs as fee sponsor.
- Read endpoints:
  - `GET /cards/publicNft/:id`: insuredValue, grade, nftStandard, and more.
  - `GET /cards/publicNft/:id/market`: listing and owner state.
- Fees: a 2% sell fee (Jupiter docs), plus "2% royalties + marketplace fee" (CC product page). **Exact current seller fee:** [A, confirm on a devnet listing].
- CC's marketplace liquidity is "powered by Magic Eden's API" (CC product-info page).
- [V 4 Nov]

### 3.4 Redemption (shipping)

https://docs.collectorcrypt.com/vault/shipping-api and https://docs.jup.ag/user-docs/trade/gacha/shipping

- The flow:
  1. Wallet sign-in: `POST /auth/wallet/nonce` (needs **`partnerSlug` plus an allowlisted domain, issued by CC support**).
  2. Sign the 11-line message (**Ed25519 over raw UTF-8 bytes**), then `POST /auth/wallet/verify` to get a 15-minute access token.
  3. Save an address.
  4. `POST /redeem/prepare` returns unsigned transactions and a price.
  5. Sign them and `POST /blockchain/:id/burn`.
  6. Track the shipment.
- Smart wallets can prove control with a Memo-v2 transaction instead.
- Fees are by shipping zone, paid in **USDC in the burn transaction**, with optional prepaid duties. No KYC; some countries are refused.
- **No % redemption fee is mentioned** in either doc.
- [V 4 Nov]

### 3.5 Pricing data

- **CC insured value:** available from the public metadata API (`https://nft.collectorcrypt.com/metadata/{mint}`, no auth) and from the marketplace API's `insuredValue`. Gacha machine `ev` is also published. A live call returned `insuredValue: 258` for a sample card. [V 4 Nov]
- **Market price:** CC marketplace listings and offers (keyless). [V 4 Nov]
- **Magic Eden:** its instruction endpoints (buy and list transactions) **need an API key** (application form). **Tensor:** its transaction API **needs `x-tensor-api-key`** (application). Sources: https://docs.magiceden.io/reference and https://dev.tensor.trade [V 4 Nov via search; not exercised]
- **eBay-based pricing:** CC's eBay "Bidder" exists. No public eBay price API was confirmed. [A]

### 3.6 Market (evidence; see RESEARCH-FINDINGS section 2)

- **Category size:** on-chain TCG net revenue was about $113M in Q3 2026 vs $108M in Q2 (CryptoRank). [V 4 Nov via search]
- **Collector Crypt Q3:** "revenue" of $433.5M (essentially gross pack sales) and gross profit of $25.4M (5.9% margin).
- **Monthly pack sales fell** from $212.2M in June to $134.5M in September (ChainCatcher, 13 Oct 2026, citing Pine Analytics). [V 4 Nov]
- **Distribution:** Jupiter Gacha (from 13 Jul 2026) and Solflare packs. Jupiter is a distributor of CC and Phygitals packs. [V 4 Nov]
- **NEAR:** no NEAR-native tokenized-card or gacha product was found. [V 4 Nov, search only]

---

## 3.7 Our testnet setup (4 Nov)

- Dev account: `mintent-dev-mw21w9ki.testnet` (throwaway; key in `~/.near-credentials/testnet/`)
- Contract: `app.mintent-dev-mw21w9ki.testnet` (owner = relayer = dev account; MPC = `v1.signer-prod.testnet`)
- Contract treasury Solana address (path `treasury`): `BtFpGgWZ8QXMo5vsggu5ZgScj9H6ysjDU6DLN7qrMQvA`
- Token `0` card address (path `card/0`): `816XrZMq42UopEcQCXAeD4m3YEDisJcoLdh4bfaLcA2r`

## 4. Mintent scope (revised, pending user decision)

**Proposed positioning [A]:** Mintent is the NEAR front door to real graded-card packs. You pay from any of 38 chains, you sign in with an email or a passkey, and every card you pull becomes a NEAR NFT that is itself the account holding the card. Trade the NFT on NEAR and the slab's ownership moves with it. Sell it back, list it, or redeem the physical card from that NFT.

- **Inventory and randomness:** Collector Crypt's existing gacha (its keyless play API) and on-chain ECVRF.
  - Mintent holds no inventory and runs no own odds in v1.
  - The rundown's "own packs" design is deferred (reasons in RESEARCH-FINDINGS section 5).
- **NEAR contract:**
  - Each pack is a NEP-171 token minted at purchase ("sealed").
  - The contract derives a Solana address for the token through Chain Signatures (`path = "card/<token_id>"`).
  - The CC card is delivered there via `altPlayerAddress`, and the token is updated ("opened": card metadata, memo, roll, proof links). This is a dynamic NFT.
  - Only the current NEP-171 holder can ask the contract to sign for that address.
- **Payments:** 1Click deposit from any supported chain into Mintent's treasury, then credited to the user's balance in the contract.
- **Exits:** buyback (CC, 85–93%), list on the CC marketplace, transfer the NEAR NFT, withdraw the card to the user's own Solana wallet, and redeem (needs a CC `partnerSlug`; otherwise withdraw then redeem on CC).
- **Status of the blockers:** see RESEARCH-FINDINGS section 3.
