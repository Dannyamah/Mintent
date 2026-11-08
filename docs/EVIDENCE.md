# Evidence: real runs you can check

Everything here happened on public test networks with no real money: NEAR testnet, Solana devnet, Collector Crypt's devnet and Tidepool (a community testnet of NEAR Intents 1Click). **Nothing has run on mainnet yet.** This file gets the mainnet hashes after that run.

## Re-check it without any credentials

```bash
pnpm install
pnpm test                                                          # contract, checkout and relayer tests
pnpm verify:pull mintent-con-mw7mmwr5.testnet 0                    # token sold back by its new owner
pnpm verify:pull mintent-con-mw7mmwr5.testnet 1                    # token still holding its card
```

`verify:pull` reads only public data: NEAR RPC, Solana RPC and Collector Crypt's verifier. It trusts nothing from our relayer.

`pnpm test` needs Rust and `cargo-near` for the contract suite. The checkout and relayer suites need only Node.

## Full run from nothing, 8 Nov 2026: 23/23 checks in 6.3 minutes

Contract: `mintent-con-mw7mmwr5.testnet`, using the real testnet MPC network (`v1.signer-prod.testnet`). Throwaway accounts, created by the script.

| Step | What happened | Check it |
| --- | --- | --- |
| Checkout | Alice paid 25.57 test USDC through Tidepool. The treasury received exactly 25.25 on Solana (pack $25 + 1% fee), and the relayer proved that on-chain before minting | Order states in the demo log |
| Pull | Card delivered to token 0's MPC-derived address `FK4jAAZwHJgCKEKJkkLDzseootP6ojtptriWVMzfRRLB` | [Card asset](https://explorer.solana.com/address/FR2ckzK3V8TKYWBYuv5yDikcnmDHDfuKtUUwbdQrjXj5?cluster=devnet) |
| Fairness | Collector Crypt's VRF proof is valid for each pack | [Pack A](https://dev-gacha.collectorcrypt.com/verify-selection/cc-446470fa-4555-47b0-983a-e06f2540bf62), [Pack B](https://dev-gacha.collectorcrypt.com/verify-selection/cc-0236a840-9343-43fa-b3a7-9f62ac4fddfa) |
| **Attack refused** | Alice got a card transfer signed for token 1, then tried to sell the NFT. Refused: "token is locked: the card is leaving this address" | `pnpm test:contracts`, `attack_*` tests; live in `pnpm demo:testnet` |
| **Lingering rights refused** | Core delegate plugin, SPL Approve, a seller-owned durable nonce and a marketplace listing all refused by the live contract's policy | `check_card_message` on the contract |
| Handover | Token 0 moved from Alice to Bob on NEAR. The card didn't move on Solana. Alice's next signing request was rejected | `get_card` on the contract |
| Sell-back | Bob sold back through a Collector Crypt signed quote. The card returned to Collector Crypt and 53.55 USDC-Dev landed in the **NFT's own address** | [Tx `2d7rqzuc…`](https://explorer.solana.com/tx/2d7rqzuc8sdA9dhZEntJJsTeBVJpBj5tZY11Y6rnk7GMCLxZiHijvNFKn1ZrwvJZ2bJd4GPbkxXwqg6SYegy4WJA?cluster=devnet) |
| Withdraw | Bob moved the proceeds to his own Chain Signatures Solana address `58yehWNYRXnnwqadNaZjpbrsrEzKuQq54WyKLUP8SVEc` | [Tx `BJaKuBMa…`](https://explorer.solana.com/tx/BJaKuBMaiJQW67WwNXU5WzpnLJu1GcdvLUb66qrzLsubYnamVLuPeB9PWCo27R7o2ng6gpXbnzyEq57VE2iao5G?cluster=devnet) |

## The attack, before the fix

On the unprotected contract, `app2.mintent-dev-mw21w9ki.testnet`, the seller signed a transfer, sold the NFT to the buyer, then broadcast it. The buyer owned the NFT on NEAR, and the seller held the card on Solana: [tx `287sh1C2…`](https://explorer.solana.com/tx/287sh1C2HuCNznxsYBYvuKtZQ1zY3uUJoazEQ4strrkgsv15VUryMYEZfdU8svr4j7p4dCVxAZkaNThp4xsRLGge?cluster=devnet). The fix is in `docs/THREAT-MODEL.md`.

## Live checks against production (read-only, 8 Nov)

`scripts/src/mainnet-dry-check.ts` sends `dry: true` quotes to mainnet 1Click. No money moves. For a $50 pack + 1% (50.50 USDC on Solana):

| Pay with | Customer pays | Estimated time |
| --- | --- | --- |
| USDC on NEAR | ~$51.01 | 17 s |
| USDC on Arbitrum | ~$51.00 | 22 s |
| USDC on Base | ~$51.01 | 32 s |
| SOL | ~$51.11 | 17 s |
| ETH | ~$51.12 | 42 s |
| DOGE | ~$51.22 | 124 s |
| BTC | ~$51.13 | **802 s** |

## What has not been shown

- **No mainnet run.** Collector Crypt's mainnet purchase transaction hasn't been inspected by `assertSafePackTx` yet, and a mainnet sell-back hasn't been built.
- **Payment on testnet is not spent on the pack.** Tidepool's test USDC isn't the token Collector Crypt's devnet charges, so the treasury pays from pre-stocked USDC-Dev. On mainnet, both are real USDC.
- **Paying from other chains** has been quoted, not executed. The test payment came from NEAR USDC.
- **The relayer's HTTP API** has had its read routes and refusals exercised. The full flow above ran through the same code as a library, not over HTTP. The web app doesn't exist yet.
- **Redemption of a physical card** is untested. It needs a `partnerSlug` from Collector Crypt.
