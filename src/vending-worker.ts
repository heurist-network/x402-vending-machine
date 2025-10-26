import { prisma } from "./db";
import { claimJob, finishJob, releaseStaleJobs } from "./queue";
import pino from "pino";
import { buildJobProcessor } from "./job-processor";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const WORKER_ID = `vm-worker-${process.pid}`;

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || "2");
const IDLE_DELAY_MS = Number(process.env.WORKER_IDLE_DELAY_MS || "500");
const JOB_LEASE_MS = Number(process.env.JOB_LEASE_MS || "300000");
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || "60000");

const processorPromise = buildJobProcessor(log);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function processNextJob() {
  const processor = await processorPromise;
  const job = await claimJob(WORKER_ID);
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
    await processNextJob();
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
