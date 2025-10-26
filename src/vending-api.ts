import express from "express";
import cors from "cors";
import pino from "pino";
import { paymentMiddleware } from "x402-express";
import { formatUnits } from "ethers";
import { prisma } from "./db";
import { enqueueJob } from "./queue";
import { tokenMetadataKey, uploadMetadataJson, getMetadataJson } from "./r2";
import { parseXPayment, toLowerAddr } from "./xpay";
import { initContracts, readLaunch } from "./web3";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const NETWORK = "base";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = process.env.PAY_TO_VAULT! as `0x${string}`;

if (!PAY_TO) throw new Error("PAY_TO_VAULT missing");

const web3Promise = initContracts();

app.use(paymentMiddleware(
  PAY_TO,
  {
    "POST /buyTest": {
      price: "$4.50",
      network: NETWORK,
      config: {
        description: "Buy 4.50 USDC. Testing only.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            token: { type: "string", description: "Token address", required: true },
            recipient: { type: "string", description: "Optional recipient address; default is the API caller" }
          }
        }
      }
    },

    "POST /buy": {
      price: "$1.00",
      network: NETWORK,
      config: {
        description: "Buy 1 USDC worth of tokens from the vending machine. The token launch must be open to buy, and the allocation cap must not have been reached.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            token: { type: "string", description: "Token address", required: true },
            recipient: { type: "string", description: "Optional recipient address; default is the API caller" }
          }
        }
      }
    },

    "POST /buy10x": {
      price: "$10.00",
      network: NETWORK,
      config: {
        description: "Buy 10 USDC worth of tokens from the vending machine. The token launch must be open to buy, and the allocation cap must not have been reached.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            token: { type: "string", description: "Token address", required: true },
            recipient: { type: "string", description: "Optional recipient address; default is the API caller" }
          }
        }
      }
    },

    "POST /coin": {
      price: "$0.01", // TODO: change to $20 for launch
      network: NETWORK,
      config: {
        description: "Create a coin and offer it for sale.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            name: { type: "string", required: true },
            symbol: { type: "string", required: true },
            creator: { type: "string", description: "The address that can update token metadata. Default is the API caller." },
            size: { type: "string", enum: ["TEST","S","L"], required: true },
            imageUrl: { type: "string" },
            website: { type: "string" },
            docs: { type: "string" },
            twitter: { type: "string" },
            telegram: { type: "string" },
            discord: { type: "string" },
            description: { type: "string" }
          }
        }
      }
    },

    "POST /metadata/update": {
      price: "$0.01",
      network: NETWORK,
      config: {
        description: "Update token metadata. You must be the token creator to call this endpoint.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            token: { type: "string", description: "The token contract address, starting with 0x", required: true },
            imageUrl: { type: "string" },
            website: { type: "string" },
            docs: { type: "string" },
            twitter: { type: "string" },
            telegram: { type: "string" },
            discord: { type: "string" },
            description: { type: "string" }
          }
        }
      }
    },

    "POST /launches": {
      price: "$0.01",
      network: NETWORK,
      config: {
        description: "List token launches with optional filtering.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            filter: {
              type: "string",
              enum: ["open", "graduated", "refundable"],
              description: "Filter launches: 'open' (not graduated, created within 14 days), 'graduated', 'refundable' (not graduated, older than 14 days). Omit to return all launches."
            }
          }
        }
      }
    },

    "POST /token_info": {
      price: "$0.001",
      network: NETWORK,
      config: {
        description: "Get detailed information about a specific token, including launch status and purchase statistics, and token metadata.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            token: {
              type: "string",
              description: "The token contract address (e.g., 0x...)",
              required: true
            }
          }
        }
      }
    },

    "POST /buy_status": {
      price: "$0.01",
      network: NETWORK,
      config: {
        description: "Check the status of a purchase transaction.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            reference: {
              type: "string",
              description: "The reference ID returned from the buy endpoint",
              required: true
            }
          }
        }
      }
    },

    "POST /coin_status": {
      price: "$0.01",
      network: NETWORK,
      config: {
        description: "Check the status of a coin creation. Returns the token contract address if it has been created.",
        inputSchema: {
          bodyType: "json",
          bodyFields: {
            reference: {
              type: "string",
              description: "The reference ID returned from the coin endpoint",
              required: true
            }
          }
        }
      }
    }
  }
));

async function handleBuy(req: any, res: any, expectedUsdcAmount: bigint) {
  try {
    const tokenLower = toLowerAddr(req.body?.token);
    const recipient = req.body?.recipient as string | undefined;

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { onchainId: true, graduated: true, targetUsdc6d: true, usdcAccounted6d: true }
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

    const actualRecipient = recipient || payer;
    const remainingUSDC = (launch.targetUsdc6d || 0n) - (launch.usdcAccounted6d || 0n);
    const needsRefund = launch.graduated || remainingUSDC < expectedUsdcAmount;

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
        message: launch.graduated
          ? "Launch already graduated. Your payment will be refunded."
          : "Insufficient allocation remaining. Your payment will be refunded."
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
      message: "Payment received. Your tokens will be transferred to you shortly."
    });
  } catch (e) {
    log.error({ err: e }, "handleBuy failed");
    res.status(500).json({ error: "server_error" });
  }
}

app.post("/buy", async (req, res) => {
  await handleBuy(req, res, 1_000_000n);
});

app.post("/buy10x", async (req, res) => {
  await handleBuy(req, res, 10_000_000n);
});

app.post("/coin", async (req, res) => {
  const { name, symbol, size } = req.body || {};
  if (!name || !symbol || !["TEST", "S", "L"].includes(size)) {
    return res.status(400).json({ error: "bad_request" });
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

  const tempKey = `temp/${Date.now()}-${symbol}.json`;
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
  const metadataUri = await uploadMetadataJson(tempKey, metadataPayload);

  const launch = await prisma.launch.create({
    data: {
      name,
      symbol,
      size,
      creator,
      x402Nonce: nonce,
      metadataUri,
      status: "queued"
    }
  });

  await enqueueJob("COIN", `coin:${nonce}`, {
    launchId: launch.id,
    name,
    symbol,
    size,
    creator,
    initialURI: metadataUri
  }, undefined, 10);

  res.json({ ok: true, reference: launch.id, metadataUri });
});

app.post("/metadata/update", async (req, res) => {
  try {
    const tokenLower = toLowerAddr(req.body?.token);

    const xp = req.get("x-payment");
    if (!xp) return res.status(400).json({ error: "missing_x_payment_header" });
    const { payer } = parseXPayment(xp);
    if (!payer) return res.status(400).json({ error: "bad_payment_payload" });

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { creator: true, contractUri: true, name: true, symbol: true }
    });
    if (!launch) return res.status(404).json({ error: "token_not_found" });
    if (launch.creator.toLowerCase() !== payer.toLowerCase()) {
      return res.status(403).json({ error: "not_creator" });
    }

    const key = tokenMetadataKey(tokenLower);
    let existing: any;
    try {
      existing = await getMetadataJson(key);
    } catch {
      return res.status(404).json({ error: "metadata_not_found" });
    }

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

    await uploadMetadataJson(key, merged);

    res.json({ ok: true });
  } catch (e) {
    log.error({ err: e }, "metadata update failed");
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/launches", async (req, res) => {
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
      contractUri: true,
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
      onchainId: l.onchainId,
      name: l.name,
      symbol: l.symbol,
      size: l.size,
      creator: l.creator,
      contractUri: l.contractUri,
      graduated: l.graduated,
      createdAt: l.createdAt,
      usdc_accounted: formatUnits(l.usdcAccounted6d, 6),
      target_usdc: formatUnits(l.targetUsdc6d, 6),
      usdc_queued: formatUnits(l.usdcQueued6d, 6)
    })),
    notes: "The data is cached and might not be up-to-date. Call the token_info API to get fresh information for a specific token."
  });
});

app.post("/token_info", async (req, res) => {
  try {
    const tokenLower = toLowerAddr(String(req.body?.token || ""));
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenLower)) {
      return res.status(400).json({ error: "invalid_token" });
    }

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: {
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
      const key = tokenMetadataKey(tokenLower);
      metadata = await getMetadataJson(key);
    } catch {
      metadata = "Metadata not found";
    }

    res.json({
      token: tokenLower,
      launch: {
        token: tokenLower,
        onchainId: launch.onchainId,
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

app.post("/buy_status", async (req, res) => {
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

    res.json({
      reference,
      status: purchase.status,
      token: purchase.tokenLower,
      payer: purchase.payer,
      recipient: purchase.recipient,
      usdc_amount: formatUnits(purchase.usdcAmount6d, 6),
      tx_hash: purchase.txHash,
      created_at: purchase.createdAt
    });
  } catch (e) {
    log.error({ err: e }, "buy_status failed");
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/coin_status", async (req, res) => {
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
        createdAt: true
      }
    });

    if (!launch) {
      return res.status(404).json({ error: "launch_not_found" });
    }

    res.json({
      reference,
      status: launch.status,
      name: launch.name,
      symbol: launch.symbol,
      size: launch.size,
      creator: launch.creator,
      token: launch.tokenLower,
      onchain_id: launch.onchainId,
      tx_hash: launch.txHash,
      error: launch.error,
      created_at: launch.createdAt
    });
  } catch (e) {
    log.error({ err: e }, "coin_status failed");
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(process.env.PORT || 8080, () => {
  log.info(`x402 vending API on :${process.env.PORT || 8080}`);
});
