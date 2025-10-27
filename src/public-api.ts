import express from "express";
import cors from "cors";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Favicon cache
let cachedFavicon: Buffer | null = null;
let cachedType: string | null = null;
let lastFetched = 0;

/**
 * GET /favicon.ico
 * Serves a cached favicon from a remote source
 */
app.get("/favicon.ico", async (_req, res) => {
  try {
    // Cache for 1 hour
    const cacheDuration = 60 * 60 * 1000;
    const now = Date.now();
    if (!cachedFavicon || now - lastFetched > cacheDuration) {
      const remoteUrl = "https://mcp.heurist.ai/favicon.ico";
      const response = await fetch(remoteUrl);
      if (!response.ok) throw new Error(`Failed to fetch favicon: ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      cachedFavicon = buf;
      cachedType = response.headers.get("content-type") || "image/x-icon";
      lastFetched = now;
    }

    res.setHeader("Content-Type", cachedType || "image/x-icon");
    res.setHeader("Cache-Control", "public, max-age=3600"); // 1h
    res.end(cachedFavicon);
  } catch (err) {
    log.error({ err }, "Error fetching favicon");
    res.status(404).end();
  }
});

/**
 * GET /health
 * Basic health check endpoint
 */
app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    service: "x402-vending-machine",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * GET /
 * Root endpoint with API information
 */
app.get("/", async (_req, res) => {
  res.json({
    name: "x402 Vending Machine API",
    version: "1.0.0",
    endpoints: {
      public: {
        "/health": "Service health check",
        "/favicon.ico": "Favicon"
      },
      x402: {
        "/x402/buy": "Buy tokens (requires x402 payment)",
        "/x402/buy2x": "Buy 2x tokens (requires x402 payment)",
        "/x402/buy3x": "Buy 3x tokens (requires x402 payment)",
        "/x402/buy4x": "Buy 4x tokens (requires x402 payment)",
        "/x402/buy5x": "Buy 5x tokens (requires x402 payment)",
        "/x402/buy10x": "Buy 10x tokens (requires x402 payment)",
        "/x402/buy20x": "Buy 20x tokens (requires x402 payment)",
        "/x402/coin": "Create a new coin (requires x402 payment)",
        "/x402/metadata/update": "Update token metadata (requires x402 payment)",
        "/x402/launches": "List token launches (requires x402 payment)",
        "/x402/token_info": "Get token information (requires x402 payment)",
        "/x402/buy_status": "Check buy transaction status (requires x402 payment)",
        "/x402/coin_status": "Check coin creation status (requires x402 payment)"
      }
    },
    documentation: "https://docs.heurist.ai"
  });
});

const PUBLIC_PORT = process.env.PUBLIC_PORT || 8082;

app.listen(PUBLIC_PORT, () => {
  log.info(`Public API (ungated) on :${PUBLIC_PORT}`);
});
