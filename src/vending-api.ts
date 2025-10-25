import "dotenv/config";
import express from "express";
import cors from "cors";
import pino from "pino";
import { paymentMiddleware } from "x402-express";
import { formatUnits } from "ethers";
import { prisma } from "./db";
import { enqueueJob } from "./queue";
import { tokenMetadataKey, uploadMetadataJson } from "./r2";
import { parseXPayment, toLowerAddr } from "./xpay";
import { initContracts, readLaunch } from "./web3";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const NETWORK = "base";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = process.env.PAY_TO_VAULT!;

if (!PAY_TO) throw new Error("PAY_TO_VAULT missing");

const web3Promise = initContracts();

app.use(paymentMiddleware(
  PAY_TO,
  {
    "POST /buy": {
      price: "$1.00",
      network: NETWORK,
      config: {
        description: "Buy 1 USDC worth of tokens from the vending machine.",
        inputSchema: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", description: "Token address" },
            recipient: { type: "string", description: "Optional recipient address; default is the API caller" }
          }
        },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            reference: { type: "string" },
            message: { type: "string" }
          }
        }
      }
    },

    "POST /buy10x": {
      price: "$10.00",
      network: NETWORK,
      config: {
        description: "Buy 10 USDC worth of tokens from the vending machine.",
        inputSchema: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", description: "Token address" },
            recipient: { type: "string", description: "Optional recipient address; default is the API caller" }
          }
        },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            reference: { type: "string" },
            message: { type: "string" }
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
          type: "object",
          required: ["name","symbol","size"],
          properties: {
            name: { type: "string" },
            symbol: { type: "string" },
            creator: { type: "string", description: "The address that receives CONTRACT_URI_SETTER_ROLE (can update token metadata). Default is the API caller." },
            size: { type: "string", enum: ["TEST","S","L"] },
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
        description: "Creator updates token metadata JSON in R2. The API caller (from X-PAYMENT) must be the token creator.",
        inputSchema: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string" },
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

    "GET /launches": {
      price: "$0.00",
      network: NETWORK,
      config: {
        description: "List launches; filter by open|graduated|refundable with ?filter=",
        outputSchema: { type: "array" }
      }
    },

    "GET /stats": {
      price: "$0.00",
      network: NETWORK,
      config: {
        description: "Stats for a token; ?token=0x...",
        outputSchema: { type: "object" }
      }
    },

    "GET /config": {
      price: "$0.00",
      network: NETWORK,
      config: { description: "Client config" }
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

    if (launch.graduated) {
      return res.status(400).json({ error: "launch_already_graduated" });
    }

    const remainingUSDC = (launch.targetUsdc6d || 0n) - (launch.usdcAccounted6d || 0n);
    if (remainingUSDC < expectedUsdcAmount) {
      return res.status(400).json({
        error: "insufficient_allocation",
        remaining_usdc: formatUnits(remainingUSDC, 6)
      });
    }

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

    await prisma.purchase.create({
      data: {
        tokenLower,
        onchainId: launch.onchainId,
        payer: recipient || payer,
        usdcAmount6d: value,
        x402Nonce: nonce!,
        status: "queued"
      }
    }).catch(() => {});

    const job = await enqueueJob("PURCHASE", `purchase:${nonce}`, {
      tokenLower,
      payer: recipient || payer,
      usdcAmount6d: value.toString(),
      x402Nonce: nonce
    }, undefined, 3);

    return res.json({
      ok: true,
      reference: String(job.id),
      message: "Payment received. Your tokens will be transferred to you shortly."
    });
  } catch (e) {
    console.error(e);
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

  let creator = req.body?.creator;
  if (!creator) {
    const xp = req.get("x-payment");
    if (!xp) return res.status(400).json({ error: "missing_x_payment_header" });
    const { payer } = parseXPayment(xp);
    if (!payer) return res.status(400).json({ error: "bad_payment_payload" });
    creator = payer;
  }

  creator = toLowerAddr(creator);

  const bootKey = `${Date.now()}-${symbol}.json`;
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
  const metadataUri = await uploadMetadataJson(bootKey, metadataPayload);

  const job = await enqueueJob("COIN", undefined, {
    name, symbol, size, creator, initialURI: metadataUri
  }, undefined, 10);

  await prisma.coinRequest.create({
    data: {
      id: job.id.toString(),
      name,
      symbol,
      size,
      creator,
      metadataUri,
      status: "queued"
    }
  });

  res.json({ ok: true, reference: String(job.id), metadataUri });
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
    if (!launch) return res.status(404).json({ error: "unknown_token" });
    if (launch.creator.toLowerCase() !== payer.toLowerCase()) {
      return res.status(403).json({ error: "not_creator" });
    }

    const updatable = {
      image: req.body?.imageUrl ?? null,
      website: req.body?.website ?? null,
      docs: req.body?.docs ?? null,
      links: {
        twitter: req.body?.twitter ?? null,
        telegram: req.body?.telegram ?? null,
        discord: req.body?.discord ?? null
      },
      description: req.body?.description ?? null
    };

    const key = tokenMetadataKey(tokenLower);
    const merged = {
      name: launch.name,
      symbol: launch.symbol,
      ...updatable
    };
    const uri = await uploadMetadataJson(key, merged);

    await prisma.launch.update({
      where: { tokenLower },
      data: { contractUri: uri }
    });

    res.json({ ok: true, contractURI: uri });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/launches", async (req, res) => {
  const filter = String(req.query.filter || "").toLowerCase();
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
      allocatedTokens: true,
      usdcAccounted6d: true,
      targetUsdc6d: true
    }
  });

  res.json(launches.map(l => ({
    token: l.tokenLower,
    onchainId: l.onchainId,
    name: l.name,
    symbol: l.symbol,
    size: l.size,
    creator: l.creator,
    contractUri: l.contractUri,
    graduated: l.graduated,
    createdAt: l.createdAt,
    allocated_tokens: formatUnits(l.allocatedTokens.toString(), 18),
    usdc_accounted: formatUnits(l.usdcAccounted6d, 6),
    target_usdc: formatUnits(l.targetUsdc6d, 6)
  })));
});

app.get("/stats", async (req, res) => {
  try {
    const tokenLower = toLowerAddr(String(req.query.token || ""));

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
        allocatedTokens: true,
        usdcAccounted6d: true,
        targetUsdc6d: true
      }
    });

    if (!launch) return res.status(404).json({ error: "unknown_token" });

    const purchases = await prisma.purchase.aggregate({
      where: {
        tokenLower,
        status: { in: ["queued", "handled"] }
      },
      _count: true,
      _sum: { usdcAmount6d: true }
    });

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
        allocated_tokens: formatUnits(launch.allocatedTokens.toString(), 18),
        usdc_accounted: formatUnits(launch.usdcAccounted6d, 6),
        target_usdc: formatUnits(launch.targetUsdc6d, 6)
      },
      purchases: {
        count: purchases._count,
        usdc_sum: formatUnits(purchases._sum.usdcAmount6d, 6)
      }
    });
  } catch (e) {
    return res.status(400).json({ error: "bad_token" });
  }
});

app.get("/config", (_req, res) => {
  res.json({
    chainId: Number(process.env.CHAIN_ID_BASE || 8453),
    vendingMachine: process.env.VENDING_MACHINE_ADDRESS,
    usdc: USDC,
    vault: PAY_TO
  });
});

app.listen(process.env.PORT || 8080, () => {
  log.info(`x402 vending API on :${process.env.PORT || 8080}`);
});
