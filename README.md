# BNB Testnet Faucet

A small faucet that sends 0.3 tBNB on BSC Testnet (chain ID 97) to any address. One claim per address and per IP every 24 hours.

## Run it

```bash
cp .env.example .env     # then add the key of a dedicated testnet wallet
npm install
npm start
```

Open http://localhost:3000.

## Safety

- Testnet only: the server refuses to start if the RPC is not chain ID 97.
- The amount and the 24 h limit are fixed in the code, not in `.env`.
- Requests are handled one at a time, so the nonce stays clean.
- `.env` is in `.gitignore`. Use a wallet that only holds testnet tBNB.

## CI

GitHub Actions runs on every push and pull request (`.github/workflows/ci.yml`): install, syntax check, then the tests in `test/` on Node 20 and 22. The tests start the server with a throwaway key and check the API answers.

## Deploy (CD)

`render.yaml` describes the service for Render. After CI passes on `main`, Render deploys the new version on its own (`autoDeployTrigger: checksPass`). `PRIVATE_KEY` is set in the Render dashboard, never in the repo.
