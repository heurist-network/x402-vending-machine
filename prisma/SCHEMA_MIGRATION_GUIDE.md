# Schema Migration Guide: Enhanced Refund Tracking

## Overview

This migration adds payment tracking fields to the `purchases` table to enable better refund management and accounting verification. Previously, the system only tracked the purchase transaction (`tx_hash`) and refund transaction (`refund_tx_hash`), but not the original USDC payment transaction.

## Problem Statement

When refunds are needed, we need to track:
1. **When payment was made** (block number for time-based analysis)
2. **Payment transaction hash** (for verification on Basescan)
3. **Full lifecycle**: Payment → Purchase → Refund

Without this data, it's difficult to:
- Verify payments were actually made on-chain
- Audit the refund process
- Identify stuck transactions at specific points
- Match payments to purchases during discrepancy analysis

## Schema Changes

### New Fields in `purchases` Table

| Field | Type | Description |
|-------|------|-------------|
| `payment_tx_hash` | TEXT (nullable) | Transaction hash where USDC ERC-3009 AuthorizationUsed event occurred |
| `payment_block_number` | BIGINT (nullable) | Block number where USDC payment was confirmed on-chain |

### Indexes

- `idx_purchases_payment_tx_hash` - For efficient lookups by payment transaction
- `idx_purchases_payment_block_number` - For block range queries and time-based analysis

## Migration Steps

### Step 1: Backup Database

```bash
# Create a backup before applying migration
pg_dump $DATABASE_URL > backup_before_payment_tracking_$(date +%Y%m%d).sql
```

### Step 2: Apply SQL Migration

```bash
# Apply the migration
psql $DATABASE_URL < prisma/migrations/add_payment_tracking_to_purchases.sql
```

Or manually run:

```sql
-- Add columns
ALTER TABLE purchases ADD COLUMN payment_tx_hash TEXT;
ALTER TABLE purchases ADD COLUMN payment_block_number BIGINT;

-- Add indexes
CREATE INDEX idx_purchases_payment_tx_hash ON purchases(payment_tx_hash);
CREATE INDEX idx_purchases_payment_block_number ON purchases(payment_block_number);
```

### Step 3: Update Prisma Schema

The `prisma/schema.prisma` file has already been updated. Regenerate the Prisma client:

```bash
npx prisma generate
```

### Step 4: Backfill Existing Data

For existing purchases without payment tracking info, run the backfill script:

```bash
# Dry run first to see what would be updated
bun run scripts/backfill-payment-tracking.ts --dry-run true

# Apply the backfill
bun run scripts/backfill-payment-tracking.ts

# With custom block range if needed
bun run scripts/backfill-payment-tracking.ts \
  --start-block 37434263 \
  --end-block 42000000
```

### Step 5: Update Application Code

The vending-api should be updated to capture payment info when creating purchases:

```typescript
// In vending-api.ts handleBuy function
const { payer, value, nonce } = parseXPayment(xp);

// TODO: Also extract the payment transaction info
// This requires the x402 middleware to pass through the actual payment tx
// For now, this can be backfilled later using the backfill script

const purchase = await prisma.purchase.create({
  data: {
    tokenLower,
    onchainId: launch.onchainId,
    payer,
    recipient: actualRecipient,
    usdcAmount6d: value,
    x402Nonce: nonce!,
    // paymentTxHash: paymentTx,  // TODO: Get from x402 middleware
    // paymentBlockNumber: block,  // TODO: Get from x402 middleware
    status: needsRefund ? "to_refund" : "queued"
  }
});
```

## Benefits

### 1. Complete Audit Trail

Each purchase now has a complete lifecycle:
- `paymentTxHash` + `paymentBlockNumber` - When user paid
- `txHash` - When tokens were delivered (or attempted)
- `refundTxHash` - When refund was processed (if needed)

### 2. Better Refund Discrepancy Detection

The `identify-refund-discrepancies.ts` script can now:
- Match payments to purchases more reliably
- Show payment transaction in the CSV output
- Filter by block ranges for time-based analysis
- Verify payment timing vs purchase timing

### 3. Accounting Verification

With block numbers, you can:
- Track time between payment and delivery
- Identify delayed purchases
- Audit refund timing
- Generate time-based reports

### 4. On-Chain Verification

Direct links to Basescan for all transactions:
- Payment: `https://basescan.org/tx/{paymentTxHash}`
- Purchase: `https://basescan.org/tx/{txHash}`
- Refund: `https://basescan.org/tx/{refundTxHash}`

## Future Improvements

### Option 1: Separate Refund Table

Create a dedicated `refunds` table for more detailed tracking:

```sql
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID UNIQUE REFERENCES purchases(id),
  x402_nonce TEXT NOT NULL,
  payer TEXT NOT NULL,
  usdc_amount_6d BIGINT NOT NULL,

  -- Payment tracking
  payment_tx_hash TEXT NOT NULL,
  payment_block_number BIGINT NOT NULL,

  -- Refund tracking
  refund_tx_hash TEXT,
  refund_block_number BIGINT,

  status TEXT DEFAULT 'pending',
  reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
```

Benefits:
- Clean separation of concerns
- Easier to query all refunds
- Can have multiple refund attempts per purchase
- More detailed status tracking

### Option 2: Event Log Table

Create an events table to track all purchase lifecycle events:

```sql
CREATE TABLE purchase_events (
  id BIGSERIAL PRIMARY KEY,
  purchase_id UUID REFERENCES purchases(id),
  event_type TEXT NOT NULL, -- payment, purchase, refund
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  metadata JSONB
);
```

Benefits:
- Complete event history
- Easy to reconstruct timeline
- Flexible for future event types
- Good for analytics

## Rollback Plan

If you need to rollback:

```sql
-- Remove indexes
DROP INDEX IF EXISTS idx_purchases_payment_tx_hash;
DROP INDEX IF EXISTS idx_purchases_payment_block_number;

-- Remove columns
ALTER TABLE purchases DROP COLUMN IF EXISTS payment_tx_hash;
ALTER TABLE purchases DROP COLUMN IF EXISTS payment_block_number;
```

Then restore from backup if needed:

```bash
psql $DATABASE_URL < backup_before_payment_tracking_YYYYMMDD.sql
```

## Testing

After migration, verify:

1. **Backfill worked**:
```sql
SELECT
  COUNT(*) as total,
  COUNT(payment_tx_hash) as with_payment_info,
  COUNT(*) - COUNT(payment_tx_hash) as missing_payment_info
FROM purchases;
```

2. **Indexes are working**:
```sql
EXPLAIN SELECT * FROM purchases WHERE payment_tx_hash = '0x...';
-- Should show Index Scan on idx_purchases_payment_tx_hash
```

3. **Run refund discrepancy script**:
```bash
bun run scripts/identify-refund-discrepancies.ts
```

The CSV output should now include payment transaction information for all purchases.

## Support

If you encounter issues:
1. Check the backfill script logs for errors
2. Verify RPC endpoint is accessible and has full event history
3. Check that block range covers all purchases
4. Review the CSV output from identify-refund-discrepancies.ts
