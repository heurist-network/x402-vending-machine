# Development Guide

## Async Processing Architecture

This system uses an asynchronous job queue pattern to handle blockchain operations. Understanding this flow is critical for development.

## Core Concepts

### Job Queue System

- **API Layer**: Fast, accepts requests and enqueues jobs
- **Worker Layer**: Processes jobs asynchronously, interacts with blockchain
- **Database**: Shared state between API and worker
- **Watchdog**: Releases stale `in_progress` jobs so fresh workers can claim them

### Job Types

1. **COIN** - Deploy new token
2. **PURCHASE** - Process token purchase
3. **GRADUATE** - Finalize launch when cap reached
4. **REFUND** - Refund failed purchases

---

## Processing Flows

### Worker Concurrency & Supervision

- The worker process spawns `WORKER_CONCURRENCY` parallel async loops (default 2) to drive multiple operator wallets at once.
- Jobs are leased for `JOB_LEASE_MS` (default 5 minutes). If a worker stalls, the watchdog (interval `WATCHDOG_INTERVAL_MS`, default 60 seconds) unlocks and re-queues the job.
- Use PM2 to manage services: `pm2 start ecosystem.config.js` launches `vending-api` and `vending-worker` with auto-restart. Adjust env vars per app in the PM2 config.

### 1. COIN Flow (Token Creation)

**User Action**: POST `/coin` with token details

#### API Layer (`vending-api.ts`)
```
1. Parse request body: name, symbol, size, creator (optional)
2. If creator not provided → extract from X-PAYMENT header
3. Upload initial metadata to R2
4. Enqueue COIN job with maxAttempts=10
5. Insert coin_request record in DB (status='queued')
6. Return immediately to user with job reference
```

#### Worker Layer (`vending-worker.ts` - handleCOIN)
```
1. Claim COIN job from queue
2. Call blockchain: vm.coin(name, symbol, initialURI, creator, size)
3. Wait for transaction confirmation
4. Parse 'Coined' event to get token address
5. Read launch data from blockchain
6. Insert launch record in DB with all onchain data
7. Update coin_request (status='done', tokenLower, txHash)
8. Mark job as completed
```

**Status Progression**: `queued` → `in_progress` → `done`

---

### 2. PURCHASE Flow (Token Purchase)

**User Action**: POST `/buy` or `/buy10x` with token address

#### API Layer (`vending-api.ts` - handleBuy)
```
1. Parse token address and recipient
2. Query DB for launch (graduated status, allocation remaining)
3. Check if launch.graduated == false
4. Check if remainingUSDC >= expectedAmount
5. Parse X-PAYMENT header to get payer and value
6. Insert purchase record in DB (status='queued')
7. Enqueue PURCHASE job with maxAttempts=3
8. Return immediately to user
```

**Important**: API checks DB only, NOT blockchain (for speed). Therefore, it's possible that some requests pass this API layer, but rejected by the worker (because the allocation cap is reached, or because the token already graduated at the worker processing time). This is normal. We should mark these purchases as 

#### Worker Layer (`vending-worker.ts` - handlePURCHASE)
```
1. Claim PURCHASE job from queue
2. Read ACTUAL onchain state: readLaunch(vm, onchainId)
3. VALIDATE: Check if launch.graduated == true
   → If true: Update status='to_refund', enqueue REFUND, return
4. VALIDATE: Check if remaining allocation >= tokens requested
   → If false: Update status='to_refund', enqueue REFUND, return
5. Call blockchain: vm.handlePurchase(onchainId, payer, usdcAmount)
6. Wait for transaction confirmation
7. Update purchase status='completed'
8. Read updated onchain state
9. Update launch counters in DB
10. Check if usdcAccounted >= targetUSDC
    → If true: Auto-enqueue GRADUATE job
11. Mark job as completed
```

**Status Progression**:
- Success: `queued` → `in_progress` → `completed`
- Failed: `queued` → `in_progress` → `to_refund` (then REFUND job)

**Key Point**: Worker does onchain validation BEFORE processing!

---

### 3. GRADUATE Flow (Launch Finalization)

**Trigger**: Automatically enqueued when final purchase hits target USDC

#### Worker Layer (`vending-worker.ts` - handleGRADUATE)
```
1. Claim GRADUATE job from queue
2. Query DB for launch.onchainId
3. Call blockchain: vm.graduate(onchainId)
   - Swaps USDC → HEU on Uniswap V3
   - Adds liquidity to Uniswap V2
   - Enables token transfers
4. Wait for transaction confirmation
5. Update launch.graduated = true in DB
6. Mark job as completed
```

**Auto-trigger Logic** (in handlePURCHASE):
```typescript
if (!updatedL.graduated && updatedL.usdcAccounted >= updatedL.targetUSDC) {
  await enqueueJob("GRADUATE", `grad:${tokenLower}`, { tokenLower }, undefined, 10);
}
```

---

### 4. REFUND Flow (Failed Purchase Recovery)

**Trigger**: Automatically enqueued when purchase validation fails

#### Worker Layer (`vending-worker.ts` - handleREFUND)
```
1. Claim REFUND job from queue
2. Query DB for launch.onchainId
3. Call blockchain: vm.refund(onchainId, buyer)
   - Burns buyer's tokens
   - Returns USDC from vault
4. Wait for transaction confirmation
5. Update purchase status='refunded'
6. Mark job as completed
```

**When REFUND is triggered**:
- Purchase attempt on already graduated launch
- Purchase amount exceeds remaining allocation

---

## Status Tracking

### Purchase Status Values

| Status | Meaning |
|--------|---------|
| `queued` | Job enqueued, waiting for worker |
| `in_progress` | Worker processing |
| `completed` | Successfully processed on-chain |
| `to_refund` | Failed validation, refund enqueued |
| `refunded` | Refund transaction confirmed |
| `failed` | Job failed, will retry |
| `dead` | Max retries exceeded |

### Why "to_refund" vs "refunded"?

**WRONG**:
```typescript
await enqueueJob("REFUND", ...);
await prisma.purchase.update({ status: "refunded" }); // ❌ Not refunded yet!
```

**CORRECT**:
```typescript
await prisma.purchase.update({ status: "to_refund" }); // ✅ Pending refund
await enqueueJob("REFUND", ...);
// Later, in handleREFUND after tx.wait():
await prisma.purchase.update({ status: "refunded" }); // ✅ Actually refunded
```

The status must reflect reality at all times, accounting for async delays.

---


---

## Data Flow Diagram

```
User Request
    ↓
API Layer (Fast DB check)
    ↓
Enqueue Job + Insert DB record
    ↓
Return to User (200 OK)

... async gap ...

Worker picks up job
    ↓
Read ACTUAL blockchain state
    ↓
Validate onchain
    ↓
    ├─ Valid? → Process transaction
    │           ↓
    │       Update DB with new state
    │           ↓
    │       Check auto-triggers (GRADUATE)
    │
    └─ Invalid? → Enqueue REFUND
                   ↓
               Update status='to_refund'
```

---

## Common Pitfalls

### ❌ DON'T: Trust DB state in worker
```typescript
// Stale data! Another purchase may have happened
if (launch.graduated) return;
```

### ✅ DO: Always read fresh onchain state
```typescript
// Accurate! Read actual blockchain state
const L = await readLaunch(web3.vm, onchainId);
if (L.graduated) { /* enqueue refund */ }
```

### ❌ DON'T: Mark async operations as complete prematurely
```typescript
await enqueueJob("REFUND", ...);
await update({ status: "refunded" }); // ❌ Refund hasn't happened!
```

### ✅ DO: Use intermediate statuses
```typescript
await update({ status: "to_refund" });
await enqueueJob("REFUND", ...);
// In REFUND handler after tx.wait():
await update({ status: "refunded" }); // ✅ Now it's done
```

---

## Debugging Tips

### Check Job Queue
```sql
SELECT * FROM jobs WHERE status IN ('queued', 'in_progress', 'failed') ORDER BY created_at DESC;
```

### Check Purchase Status
```sql
SELECT token_lower, payer, status, created_at
FROM purchases
WHERE status = 'to_refund';
```

### Monitor Worker Logs
`grep -E "(COIN|PURCHASE|GRADUATE|REFUND)"` from logs

### Retry Failed Jobs Manually
```sql
UPDATE jobs
SET status='queued', attempts=0, run_after=now()
WHERE id=123 AND status='failed';
```

---

## Testing Scenarios

### Test Purchase → Graduate Flow
1. Create token with TEST size (only needs 4.5 USDC)
2. Buy enough to hit cap
3. Verify GRADUATE job auto-enqueued
4. Check launch.graduated = true after completion

### Test Purchase → Refund Flow
1. Create token
2. Manually graduate it: Call contract directly
3. Try to purchase (should fail validation)
4. Verify status='to_refund' and REFUND enqueued
5. Check refund transaction completes

### Test Concurrent Purchases
1. Create token with small cap
2. Submit 10 purchases simultaneously
3. Some should succeed, some get refunded
4. Verify total allocated never exceeds FAIR_CAP

---

## Key Files

- `src/vending-api.ts` - API endpoints, fast DB checks
- `src/vending-worker.ts` - Job handlers, blockchain interactions
- `src/queue.ts` - Job queue management, retry logic
- `src/web3.ts` - Blockchain reading utilities
- `prisma/schema.prisma` - Database schema

## Environment Variables

Required for worker operation:
- `RPC_URL_BASE` - Base blockchain RPC endpoint
- `VENDING_MACHINE_ADDRESS` - Deployed contract address
- `OPERATOR_KEYS` - Comma-separated private keys for operators
- `DATABASE_URL` - PostgreSQL connection string
