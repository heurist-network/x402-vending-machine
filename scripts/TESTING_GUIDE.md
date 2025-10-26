# Testing Guide

Simple Bun scripts live in this directory to help drive manual end-to-end tests. All scripts read configuration from `process.env`, but most knobs can also be provided via CLI flags. Keep your testing keys in a dedicated env file (for example `.env.testing`) and load it with Bun's `--env-file` option. **Never commit private keys.**

## Environment template

```
API_BASE_URL=http://localhost:8080
COIN_PRIVATE_KEY_ENV=PRIVATE_KEY_LAUNCHER
BUY_PRIVATE_KEY_ENV=PRIVATE_KEY_BUYER1
STATUS_PRIVATE_KEY_ENV=PRIVATE_KEY_STATUS
```

## Launch a TEST coin

```
bun run scripts/coin-test.ts --env-file .env.testing --name "Test Token" --symbol TEST --size TEST
```

Copy the returned `reference` and poll its status:

```
bun run scripts/coin-status.ts  --env-file .env.testing --reference b0ba0e57-35f3-4c06-9943-e19157a4e821 
```

List recent launches or inspect a specific token:

```
bun run scripts/db-snapshot.ts --env-file .env.testing  --limit 10 
bun run scripts/db-snapshot.ts --env-file .env.testing  --token <token-address> 
```

## Buy into the launch

```
bun --env-file .env.testing run scripts/buy-token.ts --token <token-address> --amount 1
```

Use `--amount 10` for `/buy10x` or `--test` for `/buyTest`. Track individual purchases:

```
bun --env-file .env.testing run scripts/buy-status.ts --reference <buy-reference>
```

## Run operators manually

```
bun run scripts/process-jobs.ts --env-file .env.testing  --max 1 
```

This pulls up to `max` queued jobs and executes them with the same handler logic as the worker service.

## Purge items from a table

To purge a launch:
bun run scripts/purge.ts --env-file .env.testing --launch <launch-id> 

To purge a purchase:
bun run scripts/purge.ts --env-file .env.testing --purchase <purchase-id> 

## Handy flags

- `--api` overrides `API_BASE_URL` for a single call.
- `--recipient` on `buy-token.ts` buys for another address.
- Set `SCRIPT_LOG_LEVEL=debug` for verbose output.

Keep the workflow simple, iterate quickly, and avoid committing any credentials.

