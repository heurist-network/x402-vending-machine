import { prisma } from "../src/db";
import { claimJob, finishJob } from "../src/queue";
import { buildJobProcessor } from "../src/job-processor";
import { argString, log, parseArgs } from "./script-utils";

async function main() {
  const args = parseArgs();
  const maxJobsInput = Number(argString(args, "max") || process.env.MAX_JOBS || "5");
  const maxJobs = Number.isFinite(maxJobsInput) && maxJobsInput > 0 ? maxJobsInput : 5;
  const workerId = argString(args, "worker") || `manual-${Date.now()}`;

  const processor = await buildJobProcessor(log);

  for (let i = 0; i < maxJobs; i++) {
    const job = await claimJob(workerId);
    if (!job) {
      log.info("No queued jobs");
      break;
    }

    log.info({ id: job.id, kind: job.kind }, "Processing job");
    try {
      await processor.process(job);
      await finishJob(job.id, true);
    } catch (err) {
      log.error({ err, id: job.id, kind: job.kind }, "Job failed");
      await finishJob(job.id, false, err);
    }
  }
}

main()
  .catch((err) => {
    log.error({ err }, "process-jobs failed");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
