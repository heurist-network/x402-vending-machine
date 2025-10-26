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

## Query launch information via API

Test the `/launches` endpoint to list token launches with optional filtering:

```
# List all launches
bun run scripts/launches.ts --env-file .env.testing --api http://localhost:8080

# Filter by status: open, graduated, or refundable
bun run scripts/launches.ts --env-file .env.testing --filter open
bun run scripts/launches.ts --env-file .env.testing --filter graduated
bun run scripts/launches.ts --env-file .env.testing --filter refundable
```

Get detailed token information via `/token_info`:

```
bun run scripts/token-info.ts --env-file .env.testing --token <token-address>
```

## Update token metadata

Update metadata for a token you created via `/metadata/update`:

```
bun run scripts/metadata-update.ts --env-file .env.testing --token <token-address> \
  --image-url "https://example.com/image.png" \
  --website "https://example.com" \
  --twitter "https://twitter.com/example" \
  --description "Updated description"
```

Supported metadata fields: `--image-url`, `--website`, `--docs`, `--twitter`, `--telegram`, `--discord`, `--description`. You must be the token creator to update metadata.

## Buy into the launch

```
bun run scripts/buy-token.ts --env-file .env.testing  --amount 1 --token <token-address>

bun run scripts/buy-token.ts --env-file .env.testing  --test --token <token-address>

bun run scripts/buy-token.ts --env-file .env.testing  --half --token <token-address>
```

Use `--amount 10` for `/buy10x` or `--test` for `/buyTest`. Track individual purchases:

```
bun run scripts/buy-status.ts --env-file .env.testing --reference <buy-reference>
```

# Inspect system status

List recent launches or inspect a specific token:

```
bun run scripts/db-snapshot.ts --env-file .env.testing  --limit 10
bun run scripts/db-snapshot.ts --env-file .env.testing  --token <token-address>
```

Inspect queue status:

```
# List all recent jobs (default limit 20)
bun run scripts/queue-snapshot.ts --env-file .env.testing

# List last 5 jobs
bun run scripts/queue-snapshot.ts --env-file .env.testing --limit 5

# Filter by job status (queued, processing, completed, failed)
bun run scripts/queue-snapshot.ts --env-file .env.testing --status queued

# Filter by job kind (COIN, PURCHASE, GRADUATE, REFUND)
bun run scripts/queue-snapshot.ts --env-file .env.testing --kind COIN
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

