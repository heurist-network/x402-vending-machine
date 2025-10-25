import "dotenv/config";
import express from "express";
import cors from "cors";
import pino from "pino";
import { paymentMiddleware } from "x402-express";
import { prisma } from "./db";
import { enqueueJob } from "./queue";
import { tokenMetadataKey, uploadMetadataJson } from "./r2";
import { parseXPayment, toLowerAddr } from "./xpay";
import { verifyUpdateSignature } from "./auth";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const NETWORK = "base";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = process.env.PAY_TO_VAULT!;

if (!PAY_TO) throw new Error("PAY_TO_VAULT missing");

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
      price: "$0.00",
      network: NETWORK,
      config: {
        description: "Creator updates token metadata JSON in R2.",
        inputSchema: {
          type: "object",
          required: ["token","signer","signature"],
          properties: {
            token: { type: "string" },
            signer: { type: "string", description: "EOA that must equal creator in on-chain launch" },
            signature: { type: "string", description: "personal_sign over deterministic message" },
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
    },

    "POST /admin/graduate": {
      price: "$0.00",
      network: NETWORK,
      config: {
        description: "Operator-triggered graduation (onlyOp on-chain).",
        inputSchema: { type: "object", required: ["token"], properties: { token: { type: "string" } } }
      }
    },

    "POST /admin/refund": {
      price: "$0.00",
      network: NETWORK,
      config: {
        description: "Operator-triggered refund (≥14 days, not graduated).",
        inputSchema: { type: "object", required: ["token","buyer"], properties: { token: { type: "string" }, buyer: { type: "string" } } }
      }
    }
  }
));

app.post("/buy", async (req, res) => {
  try {
    const tokenLower = toLowerAddr(req.body?.token);
    const recipient = req.body?.recipient as string | undefined;

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { onchainId: true }
    });
    if (!launch) return res.status(404).json({ error: "unknown_token" });

    const xp = req.get("x-payment");
    if (!xp) return res.status(400).json({ error: "missing_x_payment_header" });
    const { payer, value, nonce } = parseXPayment(xp);
    if (!payer || value <= 0n) return res.status(400).json({ error: "bad_payment_payload" });

    await prisma.purchase.create({
      data: {
        tokenLower,
        onchainId: launch.onchainId!,
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
    });

    return res.json({
      ok: true,
      reference: String(job.id),
      message: "Payment received. Your tokens will be transferred to you shortly."
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
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

  const bootKey = `tmp/${Date.now()}-${symbol}.json`;
  const metadataPayload = {
    name, symbol,
    description: req.body?.description ?? `${name} fair launch via x402 Vending Machine`,
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
  });

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
    const signer = toLowerAddr(req.body?.signer);
    const signature = String(req.body?.signature || "");

    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { creator: true, contractUri: true, name: true, symbol: true }
    });
    if (!launch) return res.status(404).json({ error: "unknown_token" });
    if (launch.creator.toLowerCase() !== signer) return res.status(403).json({ error: "not_creator" });

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

    if (!verifyUpdateSignature(signer, tokenLower, updatable, signature)) {
      return res.status(400).json({ error: "bad_signature" });
    }

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

  res.json(launches.map(l => ({ ...l, token: l.tokenLower })));
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
      launch: { ...launch, token: tokenLower },
      purchases: {
        count: purchases._count,
        usdc_sum_6d: purchases._sum.usdcAmount6d || 0n
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

app.post("/admin/graduate", async (req, res) => {
  const tokenLower = toLowerAddr(req.body?.token);
  const job = await enqueueJob("GRADUATE", `grad:${tokenLower}`, { tokenLower });
  res.json({ ok: true, reference: String(job.id) });
});

app.post("/admin/refund", async (req, res) => {
  const tokenLower = toLowerAddr(req.body?.token);
  const buyer = toLowerAddr(req.body?.buyer);
  const job = await enqueueJob("REFUND", `refund:${tokenLower}:${buyer}`, { tokenLower, buyer });
  res.json({ ok: true, reference: String(job.id) });
});

app.listen(process.env.PORT || 8080, () => {
  log.info(`x402 vending API on :${process.env.PORT || 8080}`);
});
