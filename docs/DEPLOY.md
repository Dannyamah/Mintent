# Deploying Mintent on Railway

Four services from this one repo, in one Railway project:

| Service | What it is | Built from | Needs a volume |
| --- | --- | --- | --- |
| `relayer-testnet` | Order pipeline and API for the free test site | `deploy/relayer.Dockerfile` | Yes, at `/data` |
| `relayer-mainnet` | The same, with real money | `deploy/relayer.Dockerfile` | Yes, at `/data` |
| `web-testnet` | The test site | `deploy/web.Dockerfile` | No |
| `web-mainnet` | The real-money site | `deploy/web.Dockerfile` | No |

Both images were built and run locally on 9 Nov 2026.

## Steps

1. **Project.** In Railway, create a project and add a service from this GitHub repo. Railway's GitHub app can read a private repo, so the repo stays private.
2. **Four services.** Add the repo three more times, then name the services as in the table above.
3. **Volumes.** On each relayer, add a volume mounted at `/data`. The order database lives there, so it survives redeploys.
4. **Domains.** On each service, open Settings > Networking > Generate Domain. Note the four `https://…up.railway.app` addresses.
5. **Variables.** On your own machine, run:
   ```bash
   cd scripts
   npx tsx src/railway-vars.ts <relayer-testnet-url> <relayer-mainnet-url> <web-testnet-url> <web-mainnet-url>
   ```
   This writes `deploy/.railway/<service>.env`, readable only by you and ignored by git. Paste each file into that service's Variables > Raw Editor. **The relayer files contain private keys.** Don't share them or paste them anywhere else.
6. **Deploy.** Railway deploys after variables change. The web services read their variables at build time, so redeploy them if you change one.
7. **Health checks (optional).** In each service's settings, set the healthcheck path to `/health` for relayers and `/healthz` for sites.
8. **Privy.** In the Privy dashboard, add both web domains to the allowed domains, and turn off test accounts.

## Check it

- `https://<relayer>/health` shows the right `network` and `contract`.
- The test site's banner links to the mainnet site, and the mainnet site's banner says "real money".
- Only one testnet relayer should run against the test contract, so stop any local one.

## What the services do on their own

- **Testnet:** each visitor and each account gets 3 free test packs a day, 40 across everyone. Change these with `TEST_PAY_PER_VISITOR`, `TEST_PAY_PER_ACCOUNT` and `TEST_PAY_PER_DAY`. Every 5 minutes the relayer recycles test USDC from the treasury to the funder, and buys devnet SOL for the treasury when it runs low.
- **Both:** only the matching web domain may call the relayer from a browser (`WEB_ORIGIN`). Keys inside RPC URLs are hidden in logs.
