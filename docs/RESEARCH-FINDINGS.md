# Mintent: Research Findings (4 Nov 2026)

This compares the product rundown (`Mintent — Product Rundown.pdf`, 29 Oct 2026) with what the current sources say. Every external fact links to its source and was checked on 4 Nov 2026. **Evidence** marks a sourced fact; **Judgment** marks my opinion.

Note: the rundown lives at the repo root as a PDF, not at `docs/mintent-rundown.md`. The repo has no commits and no other files.

---

## 1. What changed vs the rundown

| # | Rundown says | Current evidence | Impact |
| --- | --- | --- | --- |
| 1 | "Pack odds are taken on trust; users can't verify any individual draw." Our differentiator is provable fairness through OutLayer VRF. | **Collector Crypt already runs an on-chain RFC 9381 ECVRF on Solana**, with a public verifier (vrf.collectorcrypt.com, `/api/vrf/verify`). Jupiter Gacha shows a "Verify" button per pull. Sources: [CC VRF](https://docs.collectorcrypt.com/gacha/vrf), [Jupiter VRF](https://docs.jup.ag/user-docs/trade/gacha/verifiable-randomness.md) | **Provable fairness is not a differentiator.** Mert (Helius) will know this. |
| 2 | "Locked to Solana and Polygon." | **CC is on Solana plus six EVM chains** (ETH, Base, ApeChain, Monad, Arbitrum, Robinhood), with EVM→EVM bridging live. CC also has a TON joint venture (CCoT). Sources: [CC cross-chain](https://docs.collectorcrypt.com/cross-chain), [CCoT](https://ccot-docs.pages.dev/docs/collector-crypt/) | "Reach" still holds for BTC, Tron, NEAR, ZEC and other non-EVM holders and for no-wallet users, but the claim must be narrowed. |
| 3 | Redemption fee max($3, 1% of insured value), citing "Collector Crypt docs". | That page is **Collector Crypt on TON**, a separate joint venture with manual withdrawals. Solana CC redemption charges **zone-based shipping in USDC, paid in the burn transaction**. No % fee is mentioned. Sources: [CCoT withdrawing](https://ccot-docs.pages.dev/docs/tokenization/withdrawing-cards/), [Jupiter shipping](https://docs.jup.ag/user-docs/trade/gacha/shipping.md), [CC Shipping API](https://docs.collectorcrypt.com/vault/shipping-api) | Fix the fee disclosure. Quote shipping from `/redeem/estimate`. |
| 4 | Redemption needs "a one-time wallet message signature". | True for the UI. **The API flow needs a `partnerSlug` plus a domain allowlist issued by CC support.** The signature is Ed25519 over raw UTF-8 bytes; smart wallets can use a Memo-v2 proof instead. Source: [CC Shipping API](https://docs.collectorcrypt.com/vault/shipping-api) | In-app redemption needs an email to CC. That's a dependency, not desk research. |
| 5 | Mintent runs its own packs at EV = 95% of price, with a 5% pack edge and buyback at 88%. | **Live CC machines publish EV ≈ 101–110% of price** (insured value) with 85–93% buyback. Jupiter and Solflare distribute them. Sources: `GET https://gacha.collectorcrypt.com/api/machines` (4 Nov), [Jupiter buyback](https://docs.jup.ag/user-docs/trade/gacha/instant-buyback.md) | Our own 95%-EV packs would be strictly worse for users than the incumbent. **The business model needs rework** (section 5). |
| 6 | Inventory has to be bought on the open market, and partnership is "optional upside". | CC exposes a **keyless play API**: any Solana address can buy and open packs, with the card optionally sent to `altPlayerAddress`. There's a **public devnet** (dev-gacha). Also an **Invoiced Partner API** (custody, rev share, $50K credit, needs a key). Sources: [Gacha API](https://docs.collectorcrypt.com/gacha/api), [Invoiced API](https://docs.collectorcrypt.com/gacha/invoiced-api) | We can be a **front end / distribution channel** with zero inventory or capital, and test on devnet for free. |
| 7 | Liquidity via Magic Eden and Tensor APIs. | Magic Eden's instruction endpoints and Tensor's transaction API **both need API keys you apply for**. **CC's marketplace API is keyless** (the user's signature is the authorisation), has a devnet, sponsors fees, and its liquidity is "powered by Magic Eden's API". Sources: [CC Marketplace API](https://docs.collectorcrypt.com/marketplace/api), [ME reference](https://docs.magiceden.io/reference), [Tensor dev](https://dev.tensor.trade) | Use the CC marketplace API. Drop direct ME/Tensor from scope. |
| 8 | OutLayer VRF verified on-chain makes pulls provably fair. | OutLayer's "VRF" is an **Ed25519 signature inside a TEE** (Intel TDX), checked with `env::ed25519_verify`. Ed25519 isn't a unique-output VRF, so "no re-roll" rests on trusting the TEE. Source: [OutLayer VRF](https://app.outlayer.ai/llms-full.txt) (VRF.md section) | Weaker than CC's ECVRF. Not needed if we use CC packs. |
| 9 | 1Click fee 0.2% without a JWT (HACKATHON.md). | The fee docs say **+25 bps without an API key**. With a key: 20 bps default, 1 bp on stablecoin and same-asset routes, and `appFees` split 50/50. Source: [Fees](https://docs.near-intents.org/resources/fees) | Get a partner key (free application). Model fees from the docs. |
| 10 | "Mainnet transaction hashes" make every flow verifiable. | **Since 27 Oct 2026, 1Click swaps are confidential only.** Swaps settle on the NEAR Private Shard, and only the shield and unshield transactions have public hashes. Source: [Changelog](https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md) | The README must explain which steps have public hashes. Our own contract and Solana transactions stay public. |
| 11 | Pay from "35+ chains". | `GET /v0/tokens`: **215 tokens on 38 chains**. Temporary **$1,000 minimum** on swaps between external chains on 9 chains (BSC, Polygon, TON, OP, AVAX, Stellar, Monad, XLayer, ADI), and a **$100 minimum** on Tron deposits. Deposits into Intents are unaffected. Sources: live API; [changelog](https://docs.near-intents.org/changelog/overview.md) | BTC, SOL, ETH, Base, Arbitrum and NEAR are fine. **Don't demo from Tron or Polygon.** |
| 12 | Passkey sign-in (no specific product). | **NEAR Auth** (formerly FastAuth) supports passkeys, but **mainnet needs approved Auth0 credentials**. **Privy** works on mainnet with a self-serve app id and plugs into `@hot-labs/near-connect`. wallet-selector is stale (last release Dec 2025). Sources: [NEAR Auth](https://docs.near.org/web3-apps/tutorials/near-auth), [Privy](https://docs.near.org/web3-apps/tutorials/privy), [near-connect](https://docs.near.org/web3-apps/tutorials/wallet-login) | Use Privy (email plus passkey) through near-connect. Apply for NEAR Auth only as a nice-to-have. |
| 13 | Market "nearly three times a year earlier", growing. | Q3 net revenue across the category was ~$113M vs $108M in Q2 ([CryptoRank](https://cryptorank.io/insights/analytics/on-chain-trading-card-games-revenue-hits-113m-in-q3-2026)). But **CC's monthly pack sales fell from $212.2M (June) to $134.5M (September), −37%** ([ChainCatcher, 13 Oct](https://www.chaincatcher.com/en/article/2295769)). | Growing year over year but **cooling since the June peak**. Don't pitch it as "fastest-growing". |
| 14 | `nfts` track: "a Mintent card is backed by a real slab". | The track asks for "**NFTs as accounts** … hold inventory … NEP-171, sub-accounts". In the rundown, our NFTs are Solana NFTs and there's no NEAR NFT at all. Source: [track prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/10-nfts.md) | **We need a NEAR NEP-171 token that controls the Solana card** (section 5). |
| 15 | AI judges "will read and run the repo". | They **screen only**: reproducibility, feature check, report and score. Humans decide. **A LICENSE file is required.** Pre-hackathon code and libraries must be disclosed. Source: [HACKATHON.md Q-014, Q-017](https://nearhackathon.com/HACKATHON.md) | Same README approach. Add LICENSE and a disclosure section. |
| 16 | Chain Signatures cost and latency unknown. | **1 yoctoNEAR deposit plus ≥10 Tgas (~7 Tgas used) per signature.** EdDSA payload 32–1232 bytes. Testnet contract `v1.signer-prod.testnet`. Latency still undocumented. Source: [MPC README](https://github.com/near/mpc/blob/main/crates/contract/README.md) | Cost is negligible. **Latency matters**, because CC's partially signed transactions expire in about 30 s. |
| 17 | (not in rundown) | CC sells packs **from $50 on mainnet** (devnet has $25). Packs must be opened within 2 hours. Rate guards apply. Source: live `/api/machines`, [Gacha API](https://docs.collectorcrypt.com/gacha/api) | Mainnet demo floor: about $50 per pull. |

---

## 2. Market (Step 4)

- **Trend (evidence):**
  - Category net revenue Q3 2026 ≈ $113M, up from $108M in Q2 ([CryptoRank](https://cryptorank.io/insights/analytics/on-chain-trading-card-games-revenue-hits-113m-in-q3-2026)).
  - CC Q3 gross pack sales $433.1M and gross profit $25.4M, but monthly sales fell every month from June to September ([ChainCatcher](https://www.chaincatcher.com/en/article/2295769)).
  - Blockworks reports Q2 GMV of $793.6M across CC, Courtyard, Phygitals, Beezie and Monster ([Blockworks on X](https://x.com/Blockworks/status/2095542851006308449)).
  - **Verdict: still large and up year over year, but cooling month over month since June.** I found no news dated after 29 Oct.
- **Figures disagree:** CryptoRank puts Courtyard's Q3 revenue at $65.9M, while RootData implies about $7.6M of protocol income. The metric definitions differ. **Don't put precise Courtyard numbers in the pitch.**
- **Competition and distribution (evidence):**
  - Jupiter Gacha sells CC and Phygitals packs (since 13 Jul 2026), and Solflare sells packs.
  - CC has expanded to EVM chains and to TON (via CCoT, a Telegram mini app).
  - **No NEAR-native product was found** ([search](https://blocmates.com/articles/collectibles-market-pulse-check); Paras lists only ordinary NFTs).
  - Polkastarter's blog mentions NEAR deposits funding "real trading cards" as a future feature. Unverified.
- **What this changes (judgment):** the differentiation can't be fairness or Solana lock-in. It can be: (a) a **NEAR account as the card**, so NFT ownership on NEAR controls a vaulted slab; (b) funding from **BTC and other non-EVM, non-Solana assets** and no-wallet users; (c) **distribution**. Haseeb's thesis (below) is that direct-to-consumer front ends win.

---

## 3. The four blockers

None of these were executed today, because that requires devnet or testnet transactions, which I left for the build session. Status is based on documentation evidence, and each blocker has a **free devnet test** defined.

### Blocker 1: a Chain Signatures-controlled Solana address can receive and transfer CC NFTs

**Status: UNKNOWN (strong evidence it works; no transaction executed yet).**

Evidence:
- A Chain Signatures Solana address is an ordinary on-curve Ed25519 key (not a PDA), derived via `derived_public_key(path, predecessor, 1)` ([MPC README](https://github.com/near/mpc/blob/main/crates/contract/README.md)).
- The MPC signs any 32–1232-byte EdDSA payload, which covers the whole Solana message.
- CC delivers pack wins to any `playerAddress` or `altPlayerAddress` ([Gacha API](https://docs.collectorcrypt.com/gacha/api)).
- Jupiter documents wallet-to-wallet transfer of CC cards as a normal NFT send ([Gifting](https://docs.jup.ag/user-docs/trade/gacha/gifting.md)).
- pNFT transfers need a v0 transaction with a lookup table to fit 1,232 bytes ([cc-buyback](https://docs.collectorcrypt.com/gacha/cc-buyback)).

Risks:
- The pNFT rule set might reject some programs. A wallet-to-wallet transfer should pass. [Judgment]
- MPC latency.

**Free test (devnet / testnet, day 1):**
1. Derive a Solana address from a testnet account via `v1.signer-prod.testnet` (path `card/test-1`).
2. Get devnet USDC from the faucet into a second derived "treasury" address.
3. Call `generatePack` on dev-gacha (`pokemon_25`) with `altPlayerAddress` set to the card address. Sign via MPC and submit.
4. Call `openPack` and check the card arrives.
5. Build a TransferV1 (pNFT) or mpl-core Transfer from the card address to a third address, sign via MPC and broadcast.

Pass if both transactions confirm. Record the latency of each `sign`.

### Blocker 2: that address can complete CC's redemption flow

**Status: UNKNOWN (technically compatible; blocked on CC registration).**

Evidence:
- Sign-in is **Ed25519 over the raw UTF-8 message**, which `payload_v2.Eddsa` supports (32–1232 bytes; the 11-line message is well within that).
- The burn transactions come from `POST /redeem/prepare` and are signed like any transaction.
- **But `POST /auth/wallet/nonce` needs a `partnerSlug` and an allowlisted domain issued by support@collectorcrypt.com**, registered separately for devnet and production.
- Source: [Shipping API](https://docs.collectorcrypt.com/vault/shipping-api)

**Test:**
1. After CC issues a devnet slug, run nonce → MPC sign → verify → `/redeem/estimate` on devnet. Free.
2. A mainnet redemption costs the shipping fee for your zone plus the card's value (it ships to you). Estimate: $15–50 shipping [A]. **Needs your approval.**

**Fallback:** "Withdraw to my Solana wallet". The contract signs a transfer to the user's own wallet, and the user redeems on collectorcrypt.com. This works without CC's cooperation.

### Blocker 3: that address can buy from and list on a marketplace by signing API-built transactions

**Status: UNKNOWN for CC (strong evidence it works); gated for Magic Eden and Tensor.**

Evidence:
- The CC marketplace API is **keyless** and returns an unsigned transaction for `wallet`. It has a devnet (`dev-api.collectorcrypt.com`) and sponsors fees when the wallet has no SOL ([Marketplace API](https://docs.collectorcrypt.com/marketplace/api)).
- The CC gacha `generatePack` and `buyback` endpoints return **partially signed** transactions that expire about 30 s after their blockhash, which can already be up to 10 s old. So the **MPC must return a signature within roughly 15 s** or the transaction must be rebuilt.
- The `cc_buyback` program avoids this: its quote lives 600 s and we build our own transaction ([cc-buyback](https://docs.collectorcrypt.com/gacha/cc-buyback)).
- Magic Eden and Tensor transaction endpoints need API keys you apply for ([ME](https://docs.magiceden.io/reference), [Tensor](https://dev.tensor.trade)).

**Free test (devnet):** `POST /marketplace/list` for the card address from Blocker 1, sign via MPC, `POST /marketplace/broadcast`, then cancel. Measure the MPC round trip against the expiry window.

**Fallback if MPC is too slow for partially signed transactions:**
- Buy packs from a fast **hot "purchaser" key** (Mintent treasury) with `altPlayerAddress` set to the MPC card address. The cards still land in MPC-controlled addresses.
- Use `cc_buyback` quotes for buybacks.

### Blocker 4: a usable fair-value pricing source exists

**Status: VERIFIED.**

Evidence, from live calls on 4 Nov:
- `https://nft.collectorcrypt.com/metadata/9CCwLhpe…EpH6` returned "Insured Value $258".
- `https://api.collectorcrypt.com/cards/publicNft/{mint}` returned `insuredValue: "258"`, `nftStandard: "pnft"`, grade and grader. `/market` returned listing state.
- `https://gacha.collectorcrypt.com/api/machines` returned per-machine `ev`, odds and buyback %.
- All of these are keyless.

Caveat: insured value is CC's own reference value, not a market price ([Jupiter collection](https://docs.jup.ag/user-docs/trade/gacha/collection.md)). eBay-sales pricing has no confirmed public API. [A]

### Mainnet verification (do not run without your approval)

| Test | Steps | Estimated cost |
| --- | --- | --- |
| M1 Real pull | Treasury buys `pokemon_50` with `altPlayerAddress` = mainnet card address. Contract mints and updates the NFT. Optionally buy back at 85%. | $50 USDC outlay. EV insured ≈ $54.79 × 85% ≈ $46.60 back on buyback, so an **expected net cost of ~$4–10** plus ~0.01 SOL and <0.05 NEAR |
| M2 Intents funding | BTC (or SOL/ETH) → 1Click → USDC for the treasury, about $60. | ~0.25% plus network fees (BTC fee ~$1–5) [A] |
| M3 Marketplace | List the M1 card on CC, then cancel. | ~0.00001 SOL |
| M4 Redemption (needs a `partnerSlug`) | Sign in, estimate, then redeem one card. | Shipping $15–50 [A]. You receive the slab. |

**Total outlay ≈ $130–180, with an expected net loss of ≈ $10–60** depending on whether we keep or redeem the card.

---

### Spike log (4 Nov, testnet / devnet, no money)

| Test | Result |
| --- | --- |
| S1a: direct `v1.signer-prod.testnet` sign of 3 real CC devnet `generatePack` transactions (378-byte legacy message) for a derived address | All 3 signatures valid. MPC round trip median **11.7 s** (max 12.0 s). Blockhash still valid after signing in all 3. |
| S1b: same through the deployed contract `app.mintent-dev-mw21w9ki.testnet` (`sign_for_treasury`, `sign_for_card`) | Valid signatures for both the treasury and `card/0` addresses. **13.6 s** and **12.3 s**. Blockhash still valid. |
| CC devnet `generatePack` transaction shape | Legacy transaction. **CC's gacha wallet is the fee payer and has already signed.** The player signs only a USDC-Dev (`Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`) TransferChecked. The buyer needs no SOL. |
| Contract tests | 16 unit tests plus 1 sandbox end-to-end test (mock signer) pass. Transfer moves signing rights; the previous owner is rejected. |
| Solana devnet airdrop | `requestAirdrop` is closed ("faucet closed on this cluster"). Devnet SOL now comes only from https://faucet.solana.com (web). |

Blockers 1 and 3 remain **UNKNOWN** until a pack is paid, opened and the card moved, which needs devnet SOL and USDC-Dev. MPC latency is **within the window with about 5–15 s of margin**, so the hot-key fallback is not needed so far.

## 4. Regulatory (flag, don't solve)

**Evidence:**
- **Brazil:** Lei 15.211/25 bars paid random rewards for under-18s.
- **Belgium:** has treated paid loot boxes as gambling since 2018.
- **UK:** confirmed in Jan 2026 that loot boxes are not gambling under the 2005 Act.
- **Netherlands and Austria:** case law is mixed.
- **US:** no federal statute was found.
- Sources: [programminginsider](https://programminginsider.com/loot-boxes-regulation-and-where-the-line-sits-in-2026/), [coingate](https://coingate.com/gift-cards/articles/article/are-loot-boxes-gambling-where-theyre-banned-and-why); both secondary. Packs of real cards with a cash buyback are closer to gambling than cosmetic loot boxes. [Judgment]

**Disclosures that reduce risk (judgment):**
- Odds per tier and EV, shown from CC's live `/api/machines`.
- The guaranteed buyback floor (%, window) before purchase.
- An 18+ attestation.
- Geo-blocking for BE, NL, BR minors and any CC-blocked regions (the CC API returns 403 for blocked addresses).
- A per-pull proof link.
- Spend limits per day.
- Clear statements that Mintent is a front end and CC is the issuer and custodian.

Reselling CC packs (rather than operating our own) also moves the "operator of the game of chance" role toward CC, but doesn't eliminate our exposure. **Get legal advice before any public launch.**

---

## 5. Challenge the plan

### 5.1 Wrong, outdated, over-scoped or under-specified (judgment, informed by section 1)

- **Wrong or outdated:** provable fairness as the differentiator, "locked to Solana/Polygon", the 1% redemption fee, the 0.2% Intents fee, and Magic Eden/Tensor as permissionless.
- **Over-scoped for 10 days:** own inventory sourcing, an own pricing engine, own buyback treasury, three pack tiers, ME/Tensor connectors, and an OutLayer VRF contract integration.
- **Under-specified:**
  - Who pays Solana fees and rent for user addresses. (CC pays rent on gacha sends; CC sponsors marketplace fees; for transfers, use a Mintent fee payer.)
  - The 30 s expiry versus MPC latency.
  - **No NEAR-side NFT for the `nfts` track.**
  - What happens if the user transfers ownership mid-flow.
  - The treasury's custody model.
  - The README's verifiability now that swaps are confidential.

### 5.2 Is "run our own packs from open-market inventory" still right?

**No (judgment, based on evidence).** CC already offers packs at EV ≥100% with 85–93% buyback, has public on-chain ECVRF, and has keyless APIs for buying, opening, buyback, marketplace and metadata. Our own packs would be:

- worse for users (we'd need EV <100% to earn a margin),
- capital-hungry,
- riskier legally (we'd be the operator), and
- far more to build.

**Stronger and simpler:** Mintent as the **NEAR-native front door to CC packs**. NEAR adds three things nobody has:

1. **Card-account NFTs (NEP-171).** Each pull is a NEAR token whose Chain Signatures-derived Solana address holds the card. Transferring or selling the NEAR token hands over control of the slab without a Solana transaction. The token can sell back, list, withdraw or redeem. This is "NFTs as accounts … hold inventory", word for word from the track brief.
2. **Funding from 38 chains** through Intents (BTC is the headline) and email or passkey sign-in, with no Solana wallet.
3. **A NEAR-controlled seed (optional):** on Solana, CC's VRF input is SHA-256(tag ‖ purchaser signature). If the purchaser is an MPC-derived key controlled by our contract, then the transaction signature that seeds each pull is produced by NEAR's MPC network on a public contract call. That's verifiable end to end.

**Revenue (judgment):**
- An `appFees` spread on Intents deposits (e.g. 50 bps, split 50/50).
- A small convenience fee per pack.
- Later, CC's Invoiced API rev share (an adjustment line exists).

Smaller than the rundown's 13% gross, but with no inventory risk.

**Keep "own packs" as a post-hackathon option**, once CC's Invoiced API or a partnership supplies custody and pricing.

### 5.3 Minimum convincing demo (judgment)

One continuous take, under 2 minutes:

1. Email or passkey sign-in.
2. Fund $50–60 from a BTC wallet via a 1Click deposit address (pre-recorded if confirmation is slow; BTC takes ~10+ min).
3. Buy a pack, which mints a sealed NEP-171 token on NEAR.
4. Open it. The real CC card lands in the token's MPC-derived Solana address.
5. Show the proof panel: NEAR transaction, Solana transaction, CC VRF verify link, derived-address math.
6. Transfer the NEAR token to a second account. The second account (not the first) can now sell it back for USDC, which arrives at their chosen chain via Intents.

Plus a 30-second "redeem" segment if CC issues a `partnerSlug` in time. Otherwise, show withdrawal to a Solana wallet.

**For the AI judges:** a one-command devnet/testnet path (`pnpm demo:devnet`) reproduces steps 3–6 with devnet USDC, free.

### 5.4 Biggest technical risks and fallbacks

| Risk | Likelihood [A] | Fallback |
| --- | --- | --- |
| MPC signature latency exceeds CC's ~30 s window for partially signed transactions | Medium | Hot purchaser key plus `altPlayerAddress`; `cc_buyback` quotes (600 s) for buyback |
| pNFT transfer from the derived address fails (rule set, size) | Low–medium | Use Core or cNFT machines on devnet; v0 transactions with lookup tables; if all fail, a custodial vault address plus NEP-171 claims |
| CC devnet down or changes API | Low–medium | Recorded fixtures plus a mock CC server for the AI-judge path; mainnet run is the proof |
| No CC `partnerSlug` in time | Medium | Withdraw to the user's own wallet, then redeem on CC |
| Privy or near-connect friction on mainnet | Low | Use HOT or Meteor via near-connect for the demo; NEAR Auth testnet for the passkey story |
| 1Click minimums or confidential-swap quirks | Low (BTC/SOL unaffected) | Fund from SOL or NEAR USDC; use `dry: true` quotes in tests |
| Contract security (anyone asks the contract to sign for a card) | — | Sign for `card/<id>` only when predecessor = NEP-171 owner; treasury signing is owner/relayer-only; tests for every path |
| Users treat the front end as gambling | — | Disclosures (section 4); hackathon demo only, no public launch |

---

## 6. Judges: what lands and what doesn't

Sources are thin for 2026. Where no 2026 primary statement was found, the note is marked [A].

- **Illia Polosukhin (NEAR):** focuses on user-owned AI, NEAR Intents and chain abstraction ([a16z podcast](https://www.a16zcrypto.com/posts/podcast/ai-apps-near-illia-polosukhin), [Cognitive Revolution](https://www.cognitiverevolution.ai/user-owned-ai-on-chain-training-inference-and-agents-with-nears-illia-polosukhin/)).
  - Impressed by: real consumer flow into Intents, and Chain Signatures used for "one NEAR account controls assets elsewhere".
  - Put off by: a thin wrapper with NEAR as payment rail only. [A]
- **Eddy Lazzarin (a16z crypto, GP since May 2026):** technical; recent talk is about security and agentic commerce ([The Block](https://www.theblock.co/post/400012/a16z-crypto-raises-2-2-billion-fifth-fund-promotes-cto-general-partner)).
  - Impressed by: a clear trust model (who can sign for what) and a precise proof story.
  - Put off by: hand-waved "provably fair", custody ambiguity. [A]
- **Mert Mumtaz (Helius, Solana):** has said "gamers hate NFTs" ([Blockworks](https://blockworks.co/news/lightspeed-gamers-nfts-ugc-web3-open-economies-polygon)). Knows CC and Jupiter Gacha.
  - Impressed by: honest positioning as a distribution channel that brings non-Solana money into CC.
  - Put off by: claiming fairness that CC already has, or "Solana-locked" framing. [A]
- **Avichal Garg (Electric Capital):** published 26 "user-owned technology" theses for 2026 ([KuCoin summary](https://www.kucoin.com/news/flash/electric-capital-identifies-26-investment-opportunities-in-user-owned-tech-for-2026)).
  - Impressed by: user-owned card accounts and real margins.
  - Put off by: unit economics that don't hold up (our old 95%-EV packs). [A]
- **Kain Warwick (Infinex):** UX is the main barrier; passkeys; a "superapp" ([The Block](https://www.theblock.co/post/380710/inside-infinex-kain-warwick-on-building-a-superapp-to-solve-cryptos-ux-problems)).
  - Impressed by: one-tap passkey flow, no bridging, no gas prompts.
  - Put off by: wallet popups and chain names in the main loop. [A]
- **Haseeb Qureshi (Dragonfly):** direct-to-consumer front ends win, while B2B distribution underperforms. "Crypto doesn't have a free tier." Also says crypto infrastructure will be adopted by agents ([Bitcoinist](https://bitcoinist.com/dragonfly-qureshi-crypto-predictions-for-2026/amp/), CoinDesk at NEARCON Feb 2026 via search).
  - Impressed by: real money and real goods, with a D2C channel.
  - Put off by: a business that only works with partner deals. [A]
- **Stepan Gershuni (cyber•Fund):** no 2026 public statements found. cyber•Fund invests in AI × blockchain ([Benzinga 2023](https://www.benzinga.com/markets/cryptocurrency/23/12/36258057/cyber-fund-launches-100m-initiative-to-accelerate-new-ai-blockchain-products)).
  - Impressed by: [A] possibly an agent angle (for example, an agent that manages buybacks). Low priority.
- **Claude Code and Codex:** reproducibility. The README needs one command, "do X → see Y" steps, a test suite, verification scripts, honest "mainnet-only" labels, and a LICENSE.

---

## 7. Open questions

1. **Product pivot:** front end to CC packs plus card-account NFTs (recommended), or own packs as in the rundown? (Your call.)
2. **Contact Collector Crypt?** Emailing support@collectorcrypt.com would get: a `partnerSlug` for devnet and prod (redemption), an optional marketplace and gacha API key (attribution and rate limits), and possibly Invoiced API access. This is outward-facing, so it's your call. I recommend sending it on 5 Nov.
3. **Tracks:** `nfts` plus `open` (recommended), and `games` only if you want to try for it.
4. **Mainnet budget:** approve ~$130–180 outlay (section 3), and which chain to fund from (BTC is the strongest story, but slow).
5. **Accounts:** the mainnet NEAR payout account and dev accounts (you create them; I must not). A Privy app id. A 1Click partner key (application at partners.near-intents.org).
6. **Pack names:** CC machine names contain franchise names (e.g. "Elite Pokémon Gacha Pack"). Our UI would show neutral names ("$50 Elite pack"), with card art only as NFT media. OK?
7. **Unknowns to measure on day 1:** MPC EdDSA latency on testnet; whether dev-gacha cards are Core, pNFT or cNFT; CC marketplace seller fee on devnet.
8. **`verify_foreign_transaction`:** which chains are enabled is unknown. Skip unless time allows.
