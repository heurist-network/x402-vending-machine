import { prisma } from "./db";
import { Prisma } from "@prisma/client";

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
    const job = await tx.job.findFirst({
      where: {
        status: "queued",
        runAfter: { lte: new Date() }
      },
      orderBy: { id: "asc" }
    });

    if (!job) return null;

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
      data: { status: "done" }
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
        status: isDead ? "dead" : "failed",
        runAfter: isDead ? job.runAfter : new Date(Date.now() + delayMs)
      }
    });
  }
}
