import { prisma } from "./db";
import { Prisma, Job } from "@prisma/client";

export async function enqueueJob(
  kind: string,
  uniqueKey: string | undefined,
  payload: any,
  runAfter?: Date,
  maxAttempts?: number
) {
  return await prisma.job.upsert({
    where: {
      kind_uniqueKey: uniqueKey ? { kind, uniqueKey } : { kind, uniqueKey: "" }
    },
    create: {
      kind,
      uniqueKey,
      payload: payload as Prisma.InputJsonValue,
      runAfter: runAfter || new Date(),
      maxAttempts: maxAttempts ?? 8
    },
    update: {
      payload: payload as Prisma.InputJsonValue
    }
  });
}

export async function claimJob(workerId: string) {
  return await prisma.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<Job[]>`
      SELECT * FROM "jobs"
      WHERE status = 'queued' AND run_after <= NOW() AND kind != 'REFUND'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    if (!jobs.length) return null;

    const job = jobs[0];

    return await tx.job.update({
      where: { id: job.id },
      data: {
        status: "in_progress",
        lockedBy: workerId,
        lockedAt: new Date()
      }
    });
  });
}

export async function finishJob(id: bigint, ok: boolean, err?: any) {
  if (ok) {
    await prisma.job.update({
      where: { id },
      data: {
        status: "done",
        lockedBy: null,
        lockedAt: null
      }
    });
  } else {
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return;

    const newAttempts = job.attempts + 1;
    const isDead = newAttempts >= job.maxAttempts;

    const delayMs = Math.min(10000 * Math.pow(2, newAttempts - 1), 300000);

    await prisma.job.update({
      where: { id },
      data: {
        attempts: newAttempts,
        status: isDead ? "dead" : "queued",
        runAfter: isDead ? job.runAfter : new Date(Date.now() + delayMs),
        lockedBy: null,
        lockedAt: null
      }
    });
  }
}

export async function releaseStaleJobs(leaseMs: number) {
  if (leaseMs <= 0) return 0;
  const cutoff = new Date(Date.now() - leaseMs);
  const result = await prisma.job.updateMany({
    where: {
      status: "in_progress",
      lockedAt: { lt: cutoff }
    },
    data: {
      status: "dead",
      lockedBy: null,
      lockedAt: null,
      runAfter: new Date()
    }
  });
  return result.count;
}
