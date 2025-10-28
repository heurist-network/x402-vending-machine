import express from "express";
import { facilitator } from "@coinbase/x402";
import cors from "cors";
import pino from "pino";
import { paymentMiddleware } from "x402-express";
import { formatUnits } from "ethers";
import { randomUUID } from "crypto";
import { prisma } from "./db";
import { enqueueJob } from "./queue";
import { launchMetadataKey, uploadMetadataJson, getMetadataJson } from "./r2";
import { parseXPayment, toLowerAddr } from "./xpay";
import { initContracts, readLaunch } from "./web3";
import { x402EndpointSchema } from "./x402-schema";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = process.env.PAY_TO_VAULT! as `0x${string}`;

if (!PAY_TO) throw new Error("PAY_TO_VAULT missing");

const web3Promise = initContracts();

app.use(paymentMiddleware(
  PAY_TO,
  x402EndpointSchema,
  // use 'facilitator' for coinbase facilitator
  {
    url: 'https://facilitator.x402.rs',
  }
));

async function handleBuy(req: any, res: any, expectedUsdcAmount: bigint) {
  try {
    const tokenLower = toLowerAddr(req.body?.token);
    const recipient = req.body?.recipient as string | undefined;

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { onchainId: true, graduated: true, targetUsdc6d: true, usdcAccounted6d: true, usdcQueued6d: true }
    });
    if (!launch || !launch.onchainId) return res.status(404).json({ error: "unknown_token" });

    const xp = req.get("x-payment");
    if (!xp) return res.status(400).json({ error: "missing_x_payment_header" });
    const { payer, value, nonce } = parseXPayment(xp);
    if (!payer || value <= 0n) return res.status(400).json({ error: "bad_payment_payload" });

    if (value !== expectedUsdcAmount) {
      return res.status(400).json({
        error: "payment_amount_mismatch",
        expected: expectedUsdcAmount.toString(),
        received: value.toString()
      });
    }

    let msg = "";

    const actualRecipient = recipient || payer;
    const remainingUSDC = (launch.targetUsdc6d || 0n) - (launch.usdcAccounted6d || 0n); // remaining allocation in USDC
    const queuedUSDC = (launch.usdcQueued6d || 0n);
    const needsRefund = launch.graduated || remainingUSDC < expectedUsdcAmount;

    if (queuedUSDC > remainingUSDC) {
      msg = "There are more queued purchases than remaining allocation. Your payment will likely be refunded.";
    }
    else if (launch.graduated) {
      msg = "Launch already graduated. Your payment will be refunded.";
    }
    else if (remainingUSDC < expectedUsdcAmount) {
      msg = "Insufficient allocation remaining. Your payment will be refunded.";
    }
    else {
      msg = "Payment received. Your tokens will be transferred to you shortly.";
    }

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          tokenLower,
          onchainId: launch.onchainId,
          payer,
          recipient: actualRecipient,
          usdcAmount6d: value,
          x402Nonce: nonce!,
          status: needsRefund ? "to_refund" : "queued"
        }
      });

      if (!needsRefund) {
        await tx.launch.update({
          where: { tokenLower },
          data: { usdcQueued6d: { increment: value } }
        });
      }

      return created;
    });

    if (needsRefund) {
      await enqueueJob("REFUND", `refund:${nonce}`, {
        purchaseId: purchase.id,
        tokenLower,
        payer,
        usdcAmount6d: value.toString()
      }, undefined, 3);

      return res.json({
        ok: true,
        reference: purchase.id,
        message: msg
      });
    }

    await enqueueJob("PURCHASE", `purchase:${nonce}`, {
      purchaseId: purchase.id,
      tokenLower,
      recipient: actualRecipient,
      usdcAmount6d: value.toString()
    }, undefined, 3);

    return res.json({
      ok: true,
      reference: purchase.id,
      message: msg
    });
  } catch (e) {
    log.error({ err: e }, "handleBuy failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error" });
    }
  }
}

app.post("/x402/buy", async (req, res) => {
  await handleBuy(req, res, 1_000_000n);
});

app.post("/x402/buy2x", async (req, res) => {
  await handleBuy(req, res, 2_000_000n);
});

app.post("/x402/buy3x", async (req, res) => {
  await handleBuy(req, res, 3_000_000n);
});

app.post("/x402/buy4x", async (req, res) => {
  await handleBuy(req, res, 4_000_000n);
});

app.post("/x402/buy5x", async (req, res) => {
  await handleBuy(req, res, 5_000_000n);
});

app.post("/x402/buy10x", async (req, res) => {
  await handleBuy(req, res, 10_000_000n);
});

app.post("/x402/buy20x", async (req, res) => {
  await handleBuy(req, res, 20_000_000n);
});

async function handleCoin(req: any, res: any, size: "TEST" | "S" | "L") {
  try {
    const { name, symbol } = req.body || {};
    if (!name || !symbol) {
      return res.status(400).json({ error: "bad_request" });
    }

    if (name.toLowerCase().includes("heurist") || symbol.toLowerCase().includes("heurist")) {
      return res.status(400).json({ error: "invalid_name_or_symbol" });
    }

    if (name.length > 32 || symbol.length > 10) {
      return res.status(400).json({ error: "name_or_symbol_too_long" });
    }

    const xp = req.get("x-payment");
    if (!xp) return res.status(400).json({ error: "missing_x_payment_header" });
    const { payer, nonce } = parseXPayment(xp);
    if (!payer || !nonce) return res.status(400).json({ error: "bad_payment_payload" });

    let creator = req.body?.creator;
    if (!creator) {
      creator = payer;
    }

    creator = toLowerAddr(creator);

    const launchId = randomUUID();
    const metadataPayload = {
      name, symbol,
      description: req.body?.description ?? `${name} fair launch via x402 Vending Machine.`,
      creator: creator,
      image: req.body?.imageUrl || null,
      website: req.body?.website || null,
      docs: req.body?.docs || null,
      links: {
        twitter: req.body?.twitter || null,
        telegram: req.body?.telegram || null,
        discord: req.body?.discord || null
      }
    };

    const metadataKey = launchMetadataKey(launchId);
    const metadataUri = await uploadMetadataJson(metadataKey, metadataPayload);

    const launch = await prisma.launch.create({
      data: {
        id: launchId,
        name,
        symbol,
        size,
        creator,
        x402Nonce: nonce,
        contractUri: metadataUri,
        status: "queued"
      }
    });

    await enqueueJob("COIN", `coin:${nonce}`, {
      launchId: launch.id,
      name,
      symbol,
      size,
      creator,
      metadataUri
    }, undefined, 3);

    res.json({ ok: true, reference: launch.id, metadataUri, notes: "The token will be created shortly. You can call /coin_status to check the status." });
  } catch (e) {
    log.error({ err: e }, "/coin failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error" });
    }
  }
}

app.post("/x402/coin/test", async (req, res) => {
  await handleCoin(req, res, "TEST");
});

app.post("/x402/coin/sm", async (req, res) => {
  await handleCoin(req, res, "S");
});

app.post("/x402/coin/lg", async (req, res) => {
  await handleCoin(req, res, "L");
});

app.post("/x402/metadata/update", async (req, res) => {
  try {
    const tokenRaw = String(req.body?.token || req.body?.tokenAddress || "").trim();
    if (!tokenRaw) return res.status(400).json({ error: "missing_token" });

    let tokenLower: string;
    try {
      tokenLower = toLowerAddr(tokenRaw);
    } catch {
      return res.status(400).json({ error: "invalid_token" });
    }

    const xp = req.get("x-payment");
    if (!xp) return res.status(400).json({ error: "missing_x_payment_header" });
    const { payer } = parseXPayment(xp);
    if (!payer) return res.status(400).json({ error: "bad_payment_payload" });

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { id: true, creator: true, name: true, symbol: true }
    });
    if (!launch) return res.status(404).json({ error: "launch_not_found" });
    if (launch.creator.toLowerCase() !== payer.toLowerCase()) {
      return res.status(403).json({ error: "not_creator" });
    }

    const key = launchMetadataKey(launch.id);
    const existing = await getMetadataJson(key);

    const merged: any = {
      name: launch.name,
      symbol: launch.symbol,
      ...existing
    };

    if (req.body?.imageUrl !== undefined) merged.image = req.body.imageUrl;
    if (req.body?.website !== undefined) merged.website = req.body.website;
    if (req.body?.docs !== undefined) merged.docs = req.body.docs;
    if (req.body?.description !== undefined) merged.description = req.body.description;

    if (!merged.links) merged.links = {};
    if (req.body?.twitter !== undefined) merged.links.twitter = req.body.twitter;
    if (req.body?.telegram !== undefined) merged.links.telegram = req.body.telegram;
    if (req.body?.discord !== undefined) merged.links.discord = req.body.discord;

    const metadataUri = await uploadMetadataJson(key, merged);

    await prisma.launch.update({
      where: { id: launch.id },
      data: { contractUri: metadataUri }
    });

    res.json({ ok: true, metadataUri });
  } catch (e) {
    log.error({ err: e }, "metadata update failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error" });
    }
  }
});

app.post("/x402/launches", async (req, res) => {
  try {
    const filter = String(req.body?.filter || "").toLowerCase();
    const now14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    let where = {};
    if (filter === "open") {
      where = { graduated: false, createdAt: { gte: now14 } };
    } else if (filter === "graduated") {
      where = { graduated: true };
    } else if (filter === "refundable") {
      where = { graduated: false, createdAt: { lt: now14 } };
    }

    const launches = await prisma.launch.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        tokenLower: true,
        onchainId: true,
        name: true,
        symbol: true,
        size: true,
        creator: true,
        graduated: true,
        createdAt: true,
        usdcAccounted6d: true,
        targetUsdc6d: true,
        usdcQueued6d: true
      }
    });

    res.json({
      data: launches.map(l => ({
        token: l.tokenLower,
        onchainId: l.onchainId?.toString(),
        name: l.name,
        symbol: l.symbol,
        size: l.size,
        creator: l.creator,
        graduated: l.graduated,
        createdAt: l.createdAt,
        usdc_accounted: formatUnits(l.usdcAccounted6d ?? 0n, 6),
        target_usdc: formatUnits(l.targetUsdc6d ?? 0n, 6),
        usdc_queued: formatUnits(l.usdcQueued6d ?? 0n, 6)
      })),
      notes: "The data is cached and might not be up-to-date. Call the token_info API to get fresh and more detailed information for a specific token."
    });
  } catch (e) {
    log.error({ err: e }, "/launches failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error" });
    }
  }
});

app.post("/x402/token_info", async (req, res) => {
  try {
    const tokenLower = toLowerAddr(String(req.body?.token || ""));
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenLower)) {
      return res.status(400).json({ error: "invalid_token" });
    }

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: {
        id: true,
        tokenLower: true,
        onchainId: true,
        name: true,
        symbol: true,
        size: true,
        creator: true,
        contractUri: true,
        graduated: true,
        createdAt: true,
        usdcAccounted6d: true,
        targetUsdc6d: true,
        usdcQueued6d: true
      }
    });

    if (!launch) return res.status(404).json({ error: "unknown_token" });

    const queuedCount = await prisma.purchase.count({
      where: {
        tokenLower,
        status: "queued"
      }
    });

    const completedCount = await prisma.purchase.count({
      where: {
        tokenLower,
        status: "completed"
      }
    });

    let metadata = null;
    try {
      const key = launchMetadataKey(launch.id);
      metadata = await getMetadataJson(key);
    } catch {
      metadata = "Metadata not found";
    }

    res.json({
      token: tokenLower,
      launch: {
        token: tokenLower,
        onchainId: launch.onchainId?.toString(),
        name: launch.name,
        symbol: launch.symbol,
        size: launch.size,
        creator: launch.creator,
        contractUri: launch.contractUri,
        graduated: launch.graduated,
        createdAt: launch.createdAt,
        usdc_accounted: formatUnits(launch.usdcAccounted6d ?? 0n, 6),
        target_usdc: formatUnits(launch.targetUsdc6d ?? 0n, 6),
        usdc_queued: formatUnits(launch.usdcQueued6d ?? 0n, 6),
        queued_purchases: queuedCount,
        completed_purchases: completedCount
      },
      metadata,
    });
  } catch (e) {
    return res.status(400).json({ error: "bad_token" });
  }
});

app.post("/x402/buy_status", async (req, res) => {
  try {
    const reference = String(req.body?.reference || "");
    if (!reference) return res.status(400).json({ error: "missing_reference" });

    const purchase = await prisma.purchase.findUnique({
      where: { id: reference },
      select: {
        status: true,
        txHash: true,
        tokenLower: true,
        payer: true,
        recipient: true,
        usdcAmount6d: true,
        createdAt: true
      }
    });

    if (!purchase) {
      return res.status(404).json({ error: "purchase_not_found" });
    }

    let notes = "";
    if (purchase.status === "completed") {
      notes = "Purchase completed. The tokens have been transferred to your wallet. tx_hash should already be available.";
    } else if (purchase.status === "to_refund") {
      notes = "Purchase failed. The payment will be refunded.";
    } else if (purchase.status === "queued") {
      notes = "Purchase is still in progress. Please check back later.";
    }

    res.json({
      status: purchase.status,
      token: purchase.tokenLower,
      payer: purchase.payer,
      recipient: purchase.recipient,
      usdc_amount: formatUnits(purchase.usdcAmount6d, 6),
      tx_hash: purchase.txHash,
      created_at: purchase.createdAt,
      notes
    });
  } catch (e) {
    log.error({ err: e }, "buy_status failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error" });
    }
  }
});

app.post("/x402/coin_status", async (req, res) => {
  try {
    const reference = String(req.body?.reference || "");
    if (!reference) return res.status(400).json({ error: "missing_reference" });

    const launch = await prisma.launch.findUnique({
      where: { id: reference },
      select: {
        status: true,
        name: true,
        symbol: true,
        size: true,
        creator: true,
        tokenLower: true,
        onchainId: true,
        txHash: true,
        error: true,
        createdAt: true,
        graduated: true
      }
    });

    if (!launch) {
      return res.status(404).json({ error: "launch_not_found" });
    }

    let notes: string;
    if (launch.status === "failed") {
      notes = launch.error ? `Launch failed: ${launch.error}` : "Launch failed. No error message available.";
    } else if (launch.status === "active") {
      notes = launch.graduated
        ? "Launch completed and graduated. Trading on DEX is enabled."
        : "Launch completed. The token is now available for purchase.";
    } else if (launch.status === "processing") {
      notes = "Launch transaction is confirming on-chain. Please check back shortly.";
    } else {
      notes = "Launch is still in progress. Please check back later.";
    }

    res.json({
      status: launch.status,
      name: launch.name,
      symbol: launch.symbol,
      size: launch.size,
      creator: launch.creator,
      token: launch.tokenLower,
      onchain_id: launch.onchainId?.toString(),
      tx_hash: launch.txHash,
      error: launch.error,
      created_at: launch.createdAt,
      notes
    });
  } catch (e) {
    log.error({ err: e }, "coin_status failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error" });
    }
  }
});

app.listen(process.env.PORT || 8080, () => {
  log.info(`x402 vending API on :${process.env.PORT || 8080}`);
});
