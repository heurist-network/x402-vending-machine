import express from "express";
import cors from "cors";
import pino from "pino";
import path from "path";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve static assets
app.use("/assets", express.static(path.join(__dirname, "../public/assets")));

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || "8082");
const DEFAULT_BASE_URL = `http://localhost:${PUBLIC_PORT}`;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

type EndpointDescriptor = {
  path: string;
  description: string;
};

function buildEndpointMap(entries: EndpointDescriptor[]) {
  return entries.reduce<Record<string, { url: string; description: string }>>((acc, entry) => {
    acc[entry.path] = {
      url: `${PUBLIC_BASE_URL}${entry.path}`,
      description: entry.description
    };
    return acc;
  }, {});
}

const X402_ENDPOINTS = buildEndpointMap([
  { path: "/x402/buy", description: "Buy tokens (requires x402 payment)" },
  { path: "/x402/buy2x", description: "Buy 2x tokens (requires x402 payment)" },
  { path: "/x402/buy3x", description: "Buy 3x tokens (requires x402 payment)" },
  { path: "/x402/buy4x", description: "Buy 4x tokens (requires x402 payment)" },
  { path: "/x402/buy5x", description: "Buy 5x tokens (requires x402 payment)" },
  { path: "/x402/buy10x", description: "Buy 10x tokens (requires x402 payment)" },
  { path: "/x402/buy20x", description: "Buy 20x tokens (requires x402 payment)" },
  { path: "/x402/coin", description: "Create a new coin (requires x402 payment)" },
  { path: "/x402/metadata/update", description: "Update token metadata (requires x402 payment)" },
  { path: "/x402/launches", description: "List token launches (requires x402 payment)" },
  { path: "/x402/token_info", description: "Get token information (requires x402 payment)" },
  { path: "/x402/buy_status", description: "Check buy transaction status (requires x402 payment)" },
  { path: "/x402/coin_status", description: "Check coin creation status (requires x402 payment)" }
]);

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
 * Root endpoint with API information and metadata
 */
app.get("/", async (req, res) => {
  // Check if client prefers HTML (browser) or JSON (API client)
  const acceptsHtml = req.headers.accept?.includes("text/html");

  if (acceptsHtml) {
    // Serve HTML with metadata for browsers
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>x402 Vending Machine</title>

  <!-- Favicon -->
  <link rel="icon" type="image/png" sizes="192x192" href="${PUBLIC_BASE_URL}/assets/favicon-192x192.png">
  <link rel="icon" type="image/png" sizes="32x32" href="${PUBLIC_BASE_URL}/assets/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="${PUBLIC_BASE_URL}/assets/favicon-16x16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="${PUBLIC_BASE_URL}/assets/apple-touch-icon.png">

  <!-- Primary Meta Tags -->
  <meta name="title" content="x402 Vending Machine">
  <meta name="description" content="x402 Vending Machine - Create and buy tokens. Designed for humans and agents alike.">

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${PUBLIC_BASE_URL}/">
  <meta property="og:title" content="x402 Vending Machine">
  <meta property="og:description" content="x402 Vending Machine - Create and buy tokens. Designed for humans and agents alike.">
  <meta property="og:image" content="${PUBLIC_BASE_URL}/assets/vending-machine-banner.JPG">

  <!-- Twitter -->
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:url" content="${PUBLIC_BASE_URL}/">
  <meta property="twitter:title" content="x402 Vending Machine">
  <meta property="twitter:description" content="x402 Vending Machine - Create and buy tokens. Designed for humans and agents alike.">
  <meta property="twitter:image" content="${PUBLIC_BASE_URL}/assets/vending-machine-banner.JPG">

  <style>
    @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      height: 100%;
      overflow-x: hidden;
    }

    body {
      background: #2563eb;
      color: #ffffff;
      font-family: 'VT323', 'Courier New', monospace;
      font-size: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 60px 20px;
      position: relative;
    }

    body::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image:
        repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(255, 255, 255, 0.03) 2px,
          rgba(255, 255, 255, 0.03) 4px
        );
      pointer-events: none;
    }

    .container {
      max-width: 720px;
      width: 100%;
      text-align: center;
      position: relative;
      z-index: 1;
    }

    h1 {
      font-size: 48px;
      letter-spacing: 4px;
      margin-bottom: 12px;
      font-weight: 400;
      text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.2);
    }

    .subtitle {
      font-size: 24px;
      letter-spacing: 1px;
      opacity: 0.9;
      margin-bottom: 80px;
    }

    .section {
      margin-bottom: 60px;
      text-align: left;
    }

    h2 {
      font-size: 24px;
      letter-spacing: 2px;
      margin-bottom: 20px;
      opacity: 0.7;
      text-transform: uppercase;
    }

    .endpoint {
      margin: 12px 0;
      font-size: 18px;
      line-height: 1.4;
    }

    .endpoint-path {
      font-family: 'VT323', monospace;
      letter-spacing: 1px;
      opacity: 0.95;
    }

    .endpoint-desc {
      font-size: 16px;
      opacity: 0.6;
      margin-left: 20px;
    }

    .footer {
      margin-top: 80px;
      font-size: 18px;
      opacity: 0.7;
    }

    a {
      color: #ffffff;
      text-decoration: none;
      border-bottom: 1px solid rgba(255, 255, 255, 0.3);
      transition: border-color 0.2s;
    }

    a:hover {
      border-bottom-color: rgba(255, 255, 255, 0.8);
    }

    .cursor {
      display: inline-block;
      width: 10px;
      height: 20px;
      background: rgba(255, 255, 255, 0.8);
      animation: blink 1s infinite;
      vertical-align: text-bottom;
      margin-left: 2px;
    }

    @keyframes blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }

    @media (max-width: 640px) {
      body { padding: 40px 20px; }
      h1 { font-size: 32px; }
      .subtitle { font-size: 20px; margin-bottom: 60px; }
      .endpoint { font-size: 16px; }
      .endpoint-desc { font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>X402 VENDING MACHINE</h1>
    <p class="subtitle">create and buy tokens. designed for humans and agents alike<span class="cursor"></span></p>

    <div class="section">
      <h2>// Public</h2>
      <div class="endpoint">
        <div class="endpoint-path">/health</div>
        <div class="endpoint-desc">→ service health check</div>
      </div>
    </div>

    <div class="section">
      <h2>// X402 Protocol</h2>
      ${Object.entries(X402_ENDPOINTS).map(([path, info]) => {
        const desc = info.description.toLowerCase().replace('(requires x402 payment)', '').trim();
        return `<div class="endpoint">
        <div class="endpoint-path">${path}</div>
        <div class="endpoint-desc">→ ${desc}</div>
      </div>`;
      }).join('\\n      ')}
    </div>

    <div class="footer">
      community <a href="https://t.me/heurist_ai" target="_blank">https://t.me/heurist_ai</a><br>
      follow us <a href="https://x.com/heurist_ai" target="_blank">https://x.com/heurist_ai</a><br>
      coin it on <a href="https://www.x402scan.com/server/a973dd7f-e4e1-4fdc-a635-151103d27e12" target="_blank">x402scan</a>
    </div>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } else {
    // Serve JSON for API clients
    res.json({
      name: "x402 Vending Machine API",
      version: "1.0.0",
      endpoints: {
        public: {
          "/health": "Service health check",
          "/favicon.ico": "Favicon"
        },
        x402: X402_ENDPOINTS
      },
      documentation: "https://docs.heurist.ai"
    });
  }
});

app.listen(PUBLIC_PORT, () => {
  log.info(`Public API (ungated) on :${PUBLIC_PORT} (base: ${PUBLIC_BASE_URL})`);
});
