import express from "express";
import cors from "cors";
import pino from "pino";
import { generateJwt } from "@coinbase/cdp-sdk/auth";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID!;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET!;

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET are required");
}

/**
 * Generate a JWT Bearer token for Coinbase CDP API authentication
 * @param method HTTP method (GET, POST, etc.)
 * @param host API host (e.g., "api.cdp.coinbase.com")
 * @param path API path (e.g., "/platform/v2/x402/supported")
 */
async function generateCDPBearerToken(method: string, host: string, path: string): Promise<string> {
  return await generateJwt({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    requestMethod: method,
    requestHost: host,
    requestPath: path,
    expiresIn: 120 // Token valid for 2 minutes
  });
}

/**
 * GET /facilitator_health
 * Check if the Coinbase CDP x402 facilitator is functioning
 */
app.get("/facilitator_health", async (_req, res) => {
  try {
    const host = "api.cdp.coinbase.com";
    const path = "/platform/v2/x402/supported";
    const method = "GET";
    const bearerToken = await generateCDPBearerToken(method, host, path);

    const response = await fetch(`https://api.cdp.coinbase.com${path}`, {
      method: method,
      headers: {
        "Authorization": `Bearer ${bearerToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status, error: errorText }, "CDP API error");
      return res.status(503).json({
        healthy: false,
        status: "error",
        message: `CDP API returned ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json() as any;
    log.info({ data }, "CDP facilitator response");

    // The CDP API returns { kinds: [...] } with supported payment schemes
    const kinds = data?.kinds || [];
    const isHealthy = Array.isArray(kinds) && kinds.length > 0;

    return res.json({
      healthy: isHealthy,
      status: isHealthy ? "operational" : "degraded",
      facilitator: "coinbase",
      supported_payment_schemes: kinds,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    log.error({ err: e }, "facilitator_health check failed");
    return res.status(500).json({
      healthy: false,
      status: "error",
      message: "Failed to check facilitator health",
      error: e instanceof Error ? e.message : String(e)
    });
  }
});

const SYSTEM_PORT = process.env.SYSTEM_PORT || 8081;

app.listen(SYSTEM_PORT, () => {
  log.info(`System API (non-paywalled) on :${SYSTEM_PORT}`);
});
