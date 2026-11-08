# Mintent threat model

Each Mintent card is a NEP-171 token on NEAR. The real graded card is a Metaplex Core asset on Solana, held by an address that the NEAR MPC network derives for this contract at the path `card/<token_id>`. Whoever owns the token can ask the contract to sign for that address.

The hard problem: **a Solana signature outlives the NEAR state that authorised it.** "Only the current owner can sign" stops the previous owner from signing *after* a sale. It doesn't stop them from signing *before* one.

## What can go wrong for a buyer

We proved the main attack on a real deployment before fixing it. On the unprotected contract (`app2.mintent-dev-mw21w9ki.testnet`), the seller got a transfer signed, sold the NFT, then broadcast the transfer. The buyer owned the NFT on NEAR while the seller held the card on Solana: [devnet tx `287sh1C2…`](https://explorer.solana.com/tx/287sh1C2HuCNznxsYBYvuKtZQ1zY3uUJoazEQ4strrkgsv15VUryMYEZfdU8svr4j7p4dCVxAZkaNThp4xsRLGge?cluster=devnet). The PoC is `scripts/src/poc-presign-attack.ts`.

| # | How a seller tries to keep the card or money | What stops it | Where |
| --- | --- | --- | --- |
| 1 | Sign a card transfer, sell the NFT, broadcast the transfer | A signature that moves the card puts the token in `Exiting`, and `nft_transfer` refuses until the relayer records the outcome | `sign_for_card`, `assert_transferable` |
| 2 | Sign a drain of the token's USDC proceeds, sell, broadcast | Every card signature locks transfers for 5 minutes. A blockhash lives at most 150 blocks (about 36 s on devnet, 60–90 s on mainnet) | `SIGN_LOCK_MS` |
| 3 | Use their own durable nonce, so the signature never expires | `AdvanceNonce` is allowed only first, and only on Mintent's nonce accounts | `classify_card_message` |
| 4 | Sign with Mintent's nonce account, wait out the lock, sell, broadcast later | That nonce's authority and the fee payer are the treasury, so it can't land without the relayer's signature, and the relayer re-checks the owner before co-signing | `CardOps.finalize` |
| 5 | Add a Core `TransferDelegate` plugin, sell, then move the card with the delegate | Only Core `TransferV1` is allowed. No plugin instruction can be signed | `classify_card_message` |
| 6 | SPL `Approve`, `SetAuthority` or `CloseAccount` on the proceeds account | Only `TransferChecked` is allowed, and only for allowlisted payment mints | `classify_card_message` |
| 7 | List the card cheaply to their own alt account, sell the NFT, buy through the listing | The marketplace program isn't on the allowlist. To list, withdraw the card to your own wallet first, which releases the token | `classify_card_message` |
| 8 | Hide instructions: lookup tables, trailing bytes, odd encodings, unknown versions | The parser is strict and fails closed on all of these, and every account must be visible | `parse_message` |
| 9 | Withdraw the card, then sell the empty NFT to someone who doesn't check | `Exiting` blocks the sale until the relayer records `Released`, which the token's view and metadata show. `verify:pull` checks the holder on Solana | `get_card`, `verify-pull.ts` |
| 10 | Sign while the pack is still sealed, before the card arrives | A sealed token can't request signatures | `sign_for_card` |

## What can go wrong for the owner

| # | Threat | Result |
| --- | --- | --- |
| 11 | The relayer tries to take a card | It can't. It has no path to `sign_for_card`; only the current owner does. Its treasury signature can't authorise anything for a card address |
| 12 | The relayer goes offline | The owner can't complete nonce transactions through the app while it's down. The token can't be stolen. A token in `Exiting` stays locked until the relayer returns |
| 13 | The relayer falsely records `Released` or `record_exit_failed` | It can corrupt the *record* and clear an exit early, which is why `verify:pull` reads the real holder from Solana. It still can't move the card |
| 14 | A front end or function-call key signs silently | `sign_for_card` needs a deposit, which function-call access keys can't attach by default |

## What can go wrong for Mintent

| # | Threat | What stops it |
| --- | --- | --- |
| 15 | A compromised CC API returns a transaction that drains the treasury | `assertSafePackTx`: only a compute budget, a memo and one USDC transfer of at most the pack price, with CC as fee payer |
| 16 | A fake "SUCCESS" from a checkout API mints free packs | The quote must name our recipient, asset and amount. Then the relayer proves on Solana that the treasury's balance rose, in a transaction no other order has used |
| 17 | A crash causes a double purchase | The purchase's signature is saved before broadcast, and its status is checked before any new pack is generated |
| 18 | A replayed order mints twice | `mint_pack` refuses a repeated `order_id` |
| 19 | The relayer's key leaks | It can spend the treasury's balance, because `sign_for_treasury` isn't policy-checked. It can't touch cards. Mitigation: keep the treasury topped up only to what's in flight |

## Trust assumptions we're stating plainly

- **The relayer is trusted for the treasury and for records,** not for cards.
- **Whoever holds the contract's full-access key can upgrade it,** which means they could sign for any card. On mainnet we recommend removing that key after deployment, so the code on-chain is the final word. The user decides this at deploy time.
- **The NEAR MPC network is trusted to sign only what the contract asks.**
- **Collector Crypt is the custodian of the physical card and the issuer of the NFT.** It could freeze or fail to redeem a card. Its VRF is verifiable on-chain, but the vault isn't.
- **Insured value is Collector Crypt's own reference price,** not a market price.

## Verify it yourself

```bash
pnpm test:contracts                 # 46 unit tests + a sandbox run; attacks are named attack_*
pnpm demo:testnet                   # runs the attacks live against the real testnet MPC network
pnpm verify:pull <contract> <token> # re-checks a pull from public data only
```
