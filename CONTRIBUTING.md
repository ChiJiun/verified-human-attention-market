# Contributing

The rules for working on this repository are in [AGENTS.md](AGENTS.md): what to read first, the accepted decisions, the contract's safety rules and the Git workflow. This page lists the checks.

## Before every commit

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint && pnpm build && pnpm format:check
cd packages/contracts && forge fmt --check && forge build --sizes && forge test -vv
```

All of them must pass. Run `pnpm test` on Node.js 24.15 or newer: the web app's DOM tests need it.

## Test layers

| Test layer | Command | Needs |
| --- | --- | --- |
| Unit + API (in memory) | `pnpm test` | nothing |
| PostgreSQL integration | `pnpm test` with `TEST_DATABASE_URL` set | PostgreSQL 16 or newer, in a database kept for tests: the run empties every table |
| Contracts | `forge test -vv` in `packages/contracts` | Foundry |
| ABI drift | `forge build && node scripts/export-abi.mjs --check` in `packages/contracts` | Foundry |
| End-to-end on a local chain | `forge build` in `packages/contracts`, then `pnpm --filter @vham/api test:e2e` with `TEST_DATABASE_URL` set | anvil on `127.0.0.1:8545` (or `E2E_RPC_URL`) and an empty PostgreSQL database; skipped when `TEST_DATABASE_URL` is not set |

A machine may lack Foundry, PostgreSQL or anvil. CI is then the required check for what it cannot run: the `solidity` job for Foundry, the `javascript` job for the PostgreSQL integration tests, and the `e2e` job for the anvil run. CI also runs an `audit` job for dependencies. [docs/DEMO.md](docs/DEMO.md) shows how to start the database and the local chain.

## Windows

Foundry runs in WSL. With a checkout that has CRLF line endings (Git's default on Windows), `pnpm format:check` and `forge fmt --check` report files that are correct in the repository. To check such a checkout, run `pnpm exec prettier --check --end-of-line auto .`; CI, which checks out LF, is the reference.

## Secrets

Never commit private keys, World ID or API secrets, RPC credentials or a filled-in `.env`. [`.env.example`](.env.example) holds variable names and safe placeholders only.
