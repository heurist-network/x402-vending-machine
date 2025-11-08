import { ethers } from "ethers";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { log } from "../script-utils";

/**
 * Shared utilities for payment tracking across refund scripts
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AUTHORIZATION_USED_SIG = "AuthorizationUsed(address,bytes32)";
const BLOCK_RANGE = 100;
const CACHE_DIR = ".cache/refund";

export type PaymentInfo = {
  txHash: string;
  blockNumber: number;
};

export type AuthorizationEvent = {
  authorizer: string;
  nonce: string;
  transactionHash: string;
  blockNumber: number;
};

/**
 * Get cache file path for authorization events
 */
function getCacheFilePath(fromBlock: number, toBlock: number): string {
  return join(CACHE_DIR, `auth-events-${fromBlock}-${toBlock}.json`);
}

/**
 * Load cached authorization events if available
 */
async function loadCachedAuthEvents(
  fromBlock: number,
  toBlock: number
): Promise<Map<string, PaymentInfo> | null> {
  const cachePath = getCacheFilePath(fromBlock, toBlock);

  if (!existsSync(cachePath)) {
    log.info({ cachePath }, "No cache file found");
    return null;
  }

  try {
    const data = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(data);

    if (parsed.fromBlock !== fromBlock || parsed.toBlock !== toBlock) {
      log.warn({ cachePath }, "Cache file block range mismatch");
      return null;
    }

    const map = new Map<string, PaymentInfo>();
    for (const [nonce, info] of Object.entries(parsed.events as Record<string, PaymentInfo>)) {
      map.set(nonce, info);
    }

    log.info({ cachePath, eventCount: map.size }, "Loaded cached authorization events");
    return map;
  } catch (err) {
    log.error({ err, cachePath }, "Failed to load cache file");
    return null;
  }
}

/**
 * Save authorization events to cache
 */
async function saveCachedAuthEvents(
  fromBlock: number,
  toBlock: number,
  events: Map<string, PaymentInfo>
): Promise<void> {
  const cachePath = getCacheFilePath(fromBlock, toBlock);

  try {
    // Create cache directory if it doesn't exist
    if (!existsSync(CACHE_DIR)) {
      await mkdir(CACHE_DIR, { recursive: true });
    }

    const data = {
      fromBlock,
      toBlock,
      timestamp: new Date().toISOString(),
      events: Object.fromEntries(events)
    };

    await writeFile(cachePath, JSON.stringify(data, null, 2), "utf-8");
    log.info({ cachePath, eventCount: events.size }, "Cached authorization events");
  } catch (err) {
    log.error({ err, cachePath }, "Failed to save cache file");
  }
}

// This function does:
// 1. Try to load from cache first
// 2. If cache doesn't exist, query blockchain for AuthorizationUsed events for the given block range
// 3. Filter the results to only include the requested nonces
export async function queryAuthorizationUsedForNonces(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
  nonces: string[],
  useCache: boolean = true
): Promise<Map<string, PaymentInfo>> {
  // Try to load from cache first
  if (useCache) {
    const cached = await loadCachedAuthEvents(fromBlock, toBlock);
    if (cached) {
      // Filter cached results to only include requested nonces
      const nonceSet = new Set(nonces.map(n => n.toLowerCase()));
      const filtered = new Map<string, PaymentInfo>();
      for (const [nonce, info] of cached) {
        if (nonceSet.has(nonce)) {
          filtered.set(nonce, info);
        }
      }
      log.info({
        totalCached: cached.size,
        filtered: filtered.size,
        requested: nonces.length
      }, "Using cached authorization events");
      return filtered;
    }
  }

  log.info({ fromBlock, toBlock, nonceCount: nonces.length }, "Querying AuthorizationUsed events from blockchain...");

  const topic0 = ethers.id(AUTHORIZATION_USED_SIG);
  const paymentInfo = new Map<string, PaymentInfo>();
  const nonceSet = new Set(nonces.map(n => n.toLowerCase()));

  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end = Math.min(start + BLOCK_RANGE - 1, toBlock);

    log.info({ progress: `Block ${start} to ${end}` }, "Querying AuthorizationUsed events...");

    const filter = {
      address: USDC_BASE,
      topics: [topic0],
      fromBlock: start,
      toBlock: end,
    };

    // Retry logic for transient RPC failures
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;

    while (attempt < maxAttempts && !success) {
      try {
        const logs = await provider.getLogs(filter);

        for (const logItem of logs) {
          const nonce = logItem.topics[2].toLowerCase();

          if (!nonceSet.has(nonce)) continue;

          paymentInfo.set(nonce, {
            txHash: logItem.transactionHash,
            blockNumber: logItem.blockNumber,
          });
        }

        log.info({ blockRange: `${start}-${end}`, matched: paymentInfo.size }, "Batch completed");
        success = true;
      } catch (err) {
        attempt++;
        if (attempt >= maxAttempts) {
          log.error({ err, blockRange: `${start}-${end}`, attempts: attempt }, "Failed to query batch after max retries");
          throw err;
        }

        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        log.warn({
          err: err instanceof Error ? err.message : String(err),
          blockRange: `${start}-${end}`,
          attempt,
          maxAttempts,
          retryInMs: backoffMs
        }, "RPC request failed, retrying...");

        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  log.info({ count: paymentInfo.size }, "Payment info retrieved from blockchain");

  // Save to cache for future use
  if (useCache) {
    await saveCachedAuthEvents(fromBlock, toBlock, paymentInfo);
  }

  return paymentInfo;
}

/**
 * Query AuthorizationUsed events and return in AuthorizationEvent format
 * Used by identify-refund-discrepancies.ts
 */
export async function queryAuthorizationUsedEvents(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number | string,
  nonces: string[],
  useCache: boolean = true
): Promise<Map<string, AuthorizationEvent>> {
  const numericToBlock = typeof toBlock === "string" ? await provider.getBlockNumber() : toBlock;

  const paymentInfoMap = await queryAuthorizationUsedForNonces(
    provider,
    fromBlock,
    numericToBlock,
    nonces,
    useCache
  );

  // Convert PaymentInfo to AuthorizationEvent format
  const authEvents = new Map<string, AuthorizationEvent>();
  for (const [nonce, info] of paymentInfoMap) {
    authEvents.set(nonce, {
      authorizer: "", // We don't extract authorizer from cached data
      nonce,
      transactionHash: info.txHash,
      blockNumber: info.blockNumber,
    });
  }

  return authEvents;
}
