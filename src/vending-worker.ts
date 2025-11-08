import { prisma } from "./db";
import { claimJob, finishJob, releaseStaleJobs } from "./queue";
import pino from "pino";
import { buildJobProcessor } from "./job-processor";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const PROCESS_ID = `vm-process-${process.pid}`;

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || "2");
const IDLE_DELAY_MS = Number(process.env.WORKER_IDLE_DELAY_MS || "500");
const JOB_LEASE_MS = Number(process.env.JOB_LEASE_MS || "600000");
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || "60000");
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || "60000");

log.info({ PROCESS_ID, CONCURRENCY, IDLE_DELAY_MS, JOB_LEASE_MS, WATCHDOG_INTERVAL_MS, RECONCILE_INTERVAL_MS }, "Worker started");

const processorPromise = buildJobProcessor(log);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function processNextJob(slot: number) {
  const processor = await processorPromise;
  const workerId = `${PROCESS_ID}-slot${slot}`;
  const job = await claimJob(workerId);
  if (!job) {
    await sleep(IDLE_DELAY_MS);
    return;
  }

  try {
    await processor.process(job);
    await finishJob(job.id, true);
  } catch (e) {
    log.error({ err: e, jobId: job.id, kind: job.kind }, "Job processing failed");
    if (job.kind === "COIN") {
      const { launchId } = job.payload as any;
      if (launchId) {
        await prisma.launch.update({
          where: { id: launchId },
          data: { status: "failed", error: String(e) }
        }).catch(() => {});
      }
    }
    await finishJob(job.id, false, e);
  }
}

async function workerLoop(slot: number) {
  log.info({ slot, concurrency: CONCURRENCY }, "Worker slot started");
  while (true) {
    await processNextJob(slot);
  }
}

for (let i = 0; i < CONCURRENCY; i++) {
  workerLoop(i).catch((err) => {
    log.error({ err }, "Worker loop crashed");
    process.exit(1);
  });
}

if (WATCHDOG_INTERVAL_MS > 0 && JOB_LEASE_MS > 0) {
  setInterval(() => {
    releaseStaleJobs(JOB_LEASE_MS)
      .then((count) => {
        if (count > 0) {
          log.warn({ count }, "Watchdog released stale jobs");
        }
      })
      .catch((err) => {
        log.error({ err }, "Watchdog failed");
      });
  }, WATCHDOG_INTERVAL_MS).unref?.();
}

if (RECONCILE_INTERVAL_MS > 0) {
  setInterval(() => {
    processorPromise
      .then((processor) => processor.reconcileBroadcastedPurchases())
      .catch((err) => {
        log.error({ err }, "Reconcile pass failed");
      });
  }, RECONCILE_INTERVAL_MS).unref?.();
}
