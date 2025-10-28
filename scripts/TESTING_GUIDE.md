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
bun run scripts/coin-test.ts --env-file .env.testing --name "New Test Token" --symbol TEST --size TEST
```

Copy the returned `reference` and poll its status:

```
bun run scripts/coin-status.ts  --env-file .env.testing --reference 5a588f8c-aef7-4d2e-87f2-64dccde4ee42
```

## Query launch information via API

Test the `/launches` endpoint to list token launches with optional filtering:

```
# List all launches
bun run --env-file .env.testing scripts/launches.ts

# Filter by status: open, graduated, or refundable
bun run --env-file .env.testing scripts/launches.ts --filter open
bun run --env-file .env.testing scripts/launches.ts --filter graduated
bun run --env-file .env.testing scripts/launches.ts --filter refundable
```

Get detailed token information via `/token_info`:

```
bun run --env-file .env.testing scripts/token-info.ts --token <token-address>
```

## Update token metadata

Update metadata for a token you created via `/metadata/update`:

```
bun run --env-file .env.testing scripts/metadata-update.ts --token <token-address> \
  --image-url "https://example.com/image.png" \
  --website "https://example.com" \
  --twitter "https://twitter.com/example" \
  --description "Updated description"
```

Supported metadata fields: `--image-url`, `--website`, `--docs`, `--twitter`, `--telegram`, `--discord`, `--description`. You must be the token creator to update metadata.

## Buy into the launch

```
bun run --env-file .env.testing scripts/buy-token.ts --amount 1 --token <token-address>

bun run --env-file .env.testing scripts/buy-token.ts --test --token <token-address>

bun run --env-file .env.testing scripts/buy-token.ts --half --token <token-address>
```

Use `--amount 10` for `/buy10x` or `--test` for `/buyTest`. Track individual purchases:

```
bun run --env-file .env.testing scripts/buy-status.ts --reference <buy-reference>
```

# Inspect system status

List recent launches or inspect a specific token:

```
bun run --env-file .env.testing scripts/db-snapshot.ts --limit 10
bun run --env-file .env.testing scripts/db-snapshot.ts --token <token-address>
```

Inspect queue status:

```
# List all recent jobs (default limit 20)
bun run --env-file .env.testing scripts/queue-snapshot.ts

# List last 5 jobs
bun run --env-file .env.testing scripts/queue-snapshot.ts --limit 5

# Filter by job status (queued, processing, completed, failed)
bun run --env-file .env.testing scripts/queue-snapshot.ts --status queued

# Filter by job kind (COIN, PURCHASE, GRADUATE, REFUND)
bun run --env-file .env.testing scripts/queue-snapshot.ts --kind COIN
```


## Run operators manually

```
bun run --env-file .env.testing scripts/process-jobs.ts --max 1
```

This pulls up to `max` queued jobs and executes them with the same handler logic as the worker service.

## Purge items from a table

To purge a launch:
bun run --env-file .env.testing scripts/purge.ts --launch <launch-id>

To purge a purchase:
bun run --env-file .env.testing scripts/purge.ts --purchase <purchase-id> 

## Handy flags

- `--api` overrides `API_BASE_URL` for a single call.
- `--recipient` on `buy-token.ts` buys for another address.
- Set `SCRIPT_LOG_LEVEL=debug` for verbose output.

Keep the workflow simple, iterate quickly, and avoid committing any credentials.

