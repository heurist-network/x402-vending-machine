import express from "express";
import cors from "cors";
import pino from "pino";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";
import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { prisma } from "./db.js";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import { enqueueJob } from "./queue.js";
import { uploadImage, uploadMetadataJson, launchMetadataKey, tokenImageKey } from "./r2.js";
import {
  LaunchStatus,
  TokenResponse,
  LaunchesResponse,
  PlatformStatsResponse,
  FacilitatorHealthResponse,
  SaleInfo,
} from "./api-types.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Vending Machine Internal API",
      version: "1.0.0",
      description: "Read-only BFF API for token launches with pagination, filtering, and search",
      contact: {
        name: "Heurist AI",
        url: "https://heurist.ai"
      }
    },
    servers: [
      {
        url: "/",
        description: "Current server- swagger test"
      },
      {
        url: "http://localhost:8081",
        description: "Local development server"
      }
    ],
    tags: [
      {
        name: "Launches",
        description: "Token launch endpoints"
      },
      {
        name: "Stats",
        description: "Platform statistics"
      },
      {
        name: "Health",
        description: "Health check endpoints"
      },
      {
        name: "Testing",
        description: "Testing endpoints for frontend development (bypasses x402 payment)"
      }
    ]
  },
  apis: ["./src/internal-api.ts"]
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Configure multer for in-memory file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'));
    }
  }
});

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const ALLOW_ALL_CORS = process.env.ALLOW_ALL_CORS === "true";

if (ALLOW_ALL_CORS) {
  // Allow all origins (for development/Swagger testing)
  app.use(cors({
    origin: "*",
    credentials: false
  }));
} else {
  app.use(cors({
    origin: FRONTEND_ORIGIN.split(",").map(origin => origin.trim()),
    credentials: true
  }));
}

app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const cache = new NodeCache({
  stdTTL: 15,
  checkperiod: 5,
  useClones: false
});

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
 * Determine launch status based on graduated flag and creation date
 */
function getLaunchStatus(launch: any): LaunchStatus {
  if (launch.graduated) {
    return LaunchStatus.graduated;
  }

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  if (launch.createdAt < fourteenDaysAgo) {
    return LaunchStatus.refundable;
  }

  return LaunchStatus.open;
}

/**
 * Fetch contract URI data (R2 file) and extract metadata
 */
async function fetchContractUriData(contractUri: string | null): Promise<any | null> {
  if (!contractUri) {
    return null;
  }

  const response = await fetch(contractUri, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch contract URI: ${response.status}`);
  }

  return await response.json();
}

/**
 * Get purchase statistics for a token
 */
async function getPurchaseStats(tokenAddress: string): Promise<{ totalPurchases: number; queuedPurchases: number }> {
  const [completed, queued] = await Promise.all([
    prisma.purchase.count({
      where: {
        tokenLower: tokenAddress.toLowerCase(),
        status: { in: ["active", "completed"] }
      }
    }),
    prisma.purchase.count({
      where: {
        tokenLower: tokenAddress.toLowerCase(),
        status: "queued"
      }
    })
  ]);

  return {
    totalPurchases: completed,
    queuedPurchases: queued
  };
}

/**
 * Format a launch for API response with all required fields
 */
async function formatLaunchForResponse(
  launch: any,
  includeMetadata = true
): Promise<TokenResponse> {
  const status = getLaunchStatus(launch);

  const currentUSDC = launch.usdcAccounted6d || BigInt(0);
  const targetUSDC = launch.targetUsdc6d || BigInt(1);

  const contractUriData = includeMetadata ? await fetchContractUriData(launch.contractUri) : null;

  const purchaseStats = launch.tokenLower
    ? await getPurchaseStats(launch.tokenLower)
    : { totalPurchases: 0, queuedPurchases: 0 };

  const saleInfo: SaleInfo = {
    currentUSDC: Number(currentUSDC) / 1_000_000,
    targetUSDC: Number(targetUSDC) / 1_000_000,
    totalPurchases: purchaseStats.totalPurchases,
    queuedPurchases: purchaseStats.queuedPurchases
  };

  const links: Record<string, string> = {};
  if (contractUriData?.links) {
    Object.entries(contractUriData.links).forEach(([key, value]) => {
      if (value && typeof value === 'string') {
        links[key] = value;
      }
    });
  }
  if (contractUriData?.website) links.website = contractUriData.website;
  if (contractUriData?.docs) links.docs = contractUriData.docs;

  const response: TokenResponse = {
    name: launch.name,
    symbol: launch.symbol,
    tokenAddress: launch.tokenLower || "",
    creatorAddress: launch.creator,
    createdAtTimestamp: Math.floor(launch.createdAt.getTime() / 1000),
    status,
    saleInfo,
    marketCap: 0,
    links,
    image: contractUriData?.image ?? null,
    description: contractUriData?.description ?? null
  };

  return response;
}

/**
 * Stale-While-Revalidate cache wrapper
 */
async function cacheSWR<T>(key: string, fetchFn: () => Promise<T>, ttl = 15): Promise<T> {
  const cached = cache.get<T>(key);

  if (cached !== undefined) {
    setImmediate(async () => {
      try {
        const fresh = await fetchFn();
        cache.set(key, fresh, ttl);
      } catch (err) {
        log.error({ err, key }, "Background cache refresh failed");
      }
    });

    return cached;
  }

  const fresh = await fetchFn();
  cache.set(key, fresh, ttl);
  return fresh;
}

// Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Vending Machine API Docs"
}));

/**
 * @swagger
 * /v1/launches:
 *   get:
 *     summary: Get all token launches
 *     description: |
 *       Paginated, searchable, and filterable list of token launches.
 *
 *       **Default behavior:** Returns open + graduated launches (excludes refundable).
 *
 *       **Filtering:**
 *       - `filter=open` - Only open launches (not graduated, < 14 days old)
 *       - `filter=graduated` - Only graduated launches
 *       - `filter=refundable` - Only refundable launches (not graduated, > 14 days old)
 *
 *       **Note:** Refundable launches are ONLY visible with `filter=refundable`.
 *     tags: [Launches]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [open, graduated, refundable]
 *         description: Filter by launch status (omit to get open + graduated only)
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search by name, symbol, or token address
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of token launches
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       symbol:
 *                         type: string
 *                       tokenAddress:
 *                         type: string
 *                       creatorAddress:
 *                         type: string
 *                       createdAtTimestamp:
 *                         type: integer
 *                         description: Unix timestamp in seconds
 *                       status:
 *                         type: string
 *                         enum: [open, graduated, refundable]
 *                       saleInfo:
 *                         type: object
 *                         properties:
 *                           currentUSDC:
 *                             type: number
 *                           targetUSDC:
 *                             type: number
 *                           totalPurchases:
 *                             type: integer
 *                           queuedPurchases:
 *                             type: integer
 *                       marketCap:
 *                         type: number
 *                       links:
 *                         type: object
 *                         additionalProperties:
 *                           type: string
 *                       image:
 *                         type: string
 *                         nullable: true
 *                         description: Token image URL (can be null if not set)
 *                       description:
 *                         type: string
 *                         nullable: true
 *                         description: Token description (can be null if not set)
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     currentPage:
 *                       type: integer
 *                     totalItems:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       500:
 *         description: Internal server error
 */
app.get("/v1/launches", async (req, res) => {
  try {
    const { filter, q, page = "1", limit = "50" } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 50));
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = `launches:${filter || "default"}:${q || ""}:${pageNum}:${limitNum}`;

    const result = await cacheSWR<LaunchesResponse>(cacheKey, async () => {
      const where: any = {};
      const now14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      if (filter && typeof filter === "string") {
        const filterValue = filter.toLowerCase();
        if (filterValue === "open") {
          where.graduated = false;
          where.createdAt = { gte: now14 };
        } else if (filterValue === "graduated") {
          where.graduated = true;
        } else if (filterValue === "refundable") {
          where.graduated = false;
          where.createdAt = { lt: now14 };
        }
      } else {
        // Default: exclude refundable launches
        where.OR = [
          { graduated: true },
          {
            graduated: false,
            createdAt: { gte: now14 }
          }
        ];
      }

      if (q && typeof q === "string" && q.trim()) {
        const searchTerm = q.trim().toLowerCase();
        const searchConditions = [
          { name: { contains: searchTerm, mode: "insensitive" } },
          { symbol: { contains: searchTerm, mode: "insensitive" } },
          { tokenLower: { contains: searchTerm } }
        ];

        if (where.OR) {
          where.AND = [
            { OR: where.OR },
            { OR: searchConditions }
          ];
          delete where.OR;
        } else {
          where.OR = searchConditions;
        }
      }

      const [launches, totalCount] = await Promise.all([
        prisma.launch.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limitNum
        }),
        prisma.launch.count({ where })
      ]);

      const formattedLaunches = await Promise.all(
        launches.map(launch => formatLaunchForResponse(launch))
      );

      const response: LaunchesResponse = {
        data: formattedLaunches,
        pagination: {
          currentPage: pageNum,
          totalItems: totalCount,
          totalPages: Math.ceil(totalCount / limitNum)
        }
      };
      return response;
    });

    res.json(result);
  } catch (err) {
    log.error({ err }, "GET /v1/launches failed");
    res.status(500).json({
      error: "internal_error",
      message: "Failed to fetch launches"
    });
  }
});

/**
 * @swagger
 * /v1/token/{address}:
 *   get:
 *     summary: Get token details
 *     description: Detailed information for a single token including metadata and purchase statistics. Returns the same structure as items in /v1/launches.
 *     tags: [Launches]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Token contract address
 *     responses:
 *       200:
 *         description: Token details with metadata and stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 symbol:
 *                   type: string
 *                 tokenAddress:
 *                   type: string
 *                 creatorAddress:
 *                   type: string
 *                 createdAtTimestamp:
 *                   type: integer
 *                   description: Unix timestamp in seconds
 *                 status:
 *                   type: string
 *                   enum: [open, graduated, refundable]
 *                 saleInfo:
 *                   type: object
 *                   properties:
 *                     currentUSDC:
 *                       type: number
 *                     targetUSDC:
 *                       type: number
 *                     totalPurchases:
 *                       type: integer
 *                     queuedPurchases:
 *                       type: integer
 *                 marketCap:
 *                   type: number
 *                 links:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                 image:
 *                   type: string
 *                   nullable: true
 *                   description: Token image URL (can be null if not set)
 *                 description:
 *                   type: string
 *                   nullable: true
 *                   description: Token description (can be null if not set)
 *       404:
 *         description: Token not found
 *       500:
 *         description: Internal server error
 */
app.get("/v1/token/:address", async (req, res) => {
  try {
    const { address } = req.params;

    const cacheKey = `token:${address.toLowerCase()}`;

    const result = await cacheSWR<TokenResponse | null>(cacheKey, async () => {
      const launch = await prisma.launch.findUnique({
        where: { tokenLower: address.toLowerCase() }
      });

      if (!launch) {
        return null;
      }

      return await formatLaunchForResponse(launch);
    });

    if (!result) {
      return res.status(404).json({ error: "token_not_found" });
    }

    res.json(result);
  } catch (err) {
    log.error({ err }, "GET /v1/token/:address failed");
    res.status(500).json({
      error: "internal_error",
      message: "Failed to fetch token"
    });
  }
});

/**
 * @swagger
 * /v1/stats:
 *   get:
 *     summary: Get platform statistics
 *     description: Platform-wide statistics including total launches and raised funds
 *     tags: [Stats]
 *     responses:
 *       200:
 *         description: Platform statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalRaisedUSDC:
 *                   type: string
 *                   description: Total USDC raised from graduated launches
 *                 totalLaunches:
 *                   type: integer
 *                   description: Total number of launches
 *                 graduatedLaunches:
 *                   type: integer
 *                   description: Number of graduated launches
 *                 openLaunches:
 *                   type: integer
 *                   description: Number of open launches
 *       500:
 *         description: Internal server error
 */
app.get("/v1/stats", async (_req, res) => {
  try {
    const cacheKey = "platform:stats";

    const result = await cacheSWR<PlatformStatsResponse>(cacheKey, async () => {
      const launches = await prisma.launch.findMany({
        select: {
          graduated: true,
          usdcAccounted6d: true
        }
      });

      const totalLaunches = launches.length;
      const graduatedLaunches = launches.filter(l => l.graduated).length;
      const openLaunches = totalLaunches - graduatedLaunches;

      const totalRaisedUSDC = launches
        .filter(l => l.graduated)
        .reduce((sum, l) => sum + Number(l.usdcAccounted6d || BigInt(0)), 0);

      const stats: PlatformStatsResponse = {
        totalRaisedUSDC: (totalRaisedUSDC / 1_000_000).toFixed(2),
        totalLaunches,
        graduatedLaunches,
        openLaunches
      };
      return stats;
    }, 300);

    res.json(result);
  } catch (err) {
    log.error({ err }, "GET /v1/stats failed");
    res.status(500).json({
      error: "internal_error",
      message: "Failed to fetch stats"
    });
  }
});

/**
 * @swagger
 * /internal/facilitator_health:
 *   get:
 *     summary: Check facilitator health
 *     description: Check if the Coinbase CDP x402 facilitator is functioning
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Facilitator is healthy
 *       503:
 *         description: Facilitator is unhealthy
 *       500:
 *         description: Health check failed
 */
app.get("/internal/facilitator_health", async (_req, res) => {
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
    throw new Error(`CDP API returned ${response.status}`);
  }

  const data = await response.json() as FacilitatorHealthResponse;
  res.json(data);
});

/**
 * @swagger
 * /internal/uploadImage:
 *   post:
 *     summary: Upload and process token image
 *     description: |
 *       Upload an image for a token launch. The image will be automatically downscaled to 400x400 pixels
 *       and uploaded to R2 storage. Returns the public URL of the uploaded image.
 *
 *       **For testing:** Use this endpoint in Swagger UI to upload an image, then use the returned imageUrl
 *       in the createCoin endpoint.
 *     tags: [Testing]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Image file (JPEG, PNG, GIF, or WebP, max 10MB)
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 imageUrl:
 *                   type: string
 *                   description: Public URL of the uploaded image
 *       400:
 *         description: Bad request (no file or invalid file type)
 *       500:
 *         description: Internal server error
 */
app.post("/internal/uploadImage", upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "no_file_uploaded" });
    }

    const fileExtension = req.file.mimetype.split('/')[1];
    const fileName = `${randomUUID()}.${fileExtension}`;
    const key = tokenImageKey(fileName);

    // Process image: downscale to 400x400
    const processedBuffer = await sharp(req.file.buffer)
      .resize(400, 400, {
        fit: 'cover',
        position: 'center'
      })
      .toBuffer();

    const imageUrl = await uploadImage(key, processedBuffer, req.file.mimetype);

    res.json({ ok: true, imageUrl });
  } catch (err) {
    log.error({ err }, "POST /internal/uploadImage failed");
    res.status(500).json({
      error: "internal_error",
      message: "Failed to upload image"
    });
  }
});

/**
 * @swagger
 * /internal/createCoin:
 *   post:
 *     summary: Create a test token launch (bypasses x402 payment)
 *     description: |
 *       Create a token launch for testing purposes without requiring x402 payment.
 *       This endpoint is intended for frontend development and testing only.
 *
 *       **Testing flow:**
 *       1. Use `/internal/uploadImage` to upload a token image and get the imageUrl
 *       2. Use this endpoint with the imageUrl and other metadata to create the token
 *       3. The token will be created and deployed on-chain
 *
 *       All fields from the regular coin creation endpoint are supported, including social links.
 *     tags: [Testing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - symbol
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 32
 *                 description: Token name
 *                 example: "Test Token"
 *               symbol:
 *                 type: string
 *                 maxLength: 10
 *                 description: Token symbol
 *                 example: "TEST"
 *               description:
 *                 type: string
 *                 description: Token description
 *                 example: "A test token for development"
 *               imageUrl:
 *                 type: string
 *                 description: Token image URL (from uploadImage endpoint)
 *                 example: "https://pub-xxxxx.r2.dev/images/xxxxx.png"
 *               creator:
 *                 type: string
 *                 description: Creator wallet address (optional, defaults to 0x0000...)
 *                 example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
 *               website:
 *                 type: string
 *                 description: Project website URL
 *                 example: "https://example.com"
 *               docs:
 *                 type: string
 *                 description: Documentation URL
 *                 example: "https://docs.example.com"
 *               twitter:
 *                 type: string
 *                 description: Twitter/X handle or URL
 *                 example: "https://twitter.com/example"
 *               telegram:
 *                 type: string
 *                 description: Telegram group URL
 *                 example: "https://t.me/example"
 *               discord:
 *                 type: string
 *                 description: Discord server URL
 *                 example: "https://discord.gg/example"
 *               size:
 *                 type: string
 *                 enum: [TEST, S, L]
 *                 default: TEST
 *                 description: Launch size (TEST for testing)
 *     responses:
 *       200:
 *         description: Token launch created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 reference:
 *                   type: string
 *                   description: Launch ID (use with /x402/coin_status to check status)
 *                 metadataUri:
 *                   type: string
 *                   description: R2 URL of the token metadata JSON
 *                 notes:
 *                   type: string
 *       400:
 *         description: Bad request (missing or invalid parameters)
 *       500:
 *         description: Internal server error
 */
app.post("/internal/createCoin", async (req, res) => {
  try {
    const { name, symbol, size = "TEST" } = req.body || {};

    if (!name || !symbol) {
      return res.status(400).json({ error: "bad_request", message: "name and symbol are required" });
    }

    if (name.toLowerCase().includes("heurist") || symbol.toLowerCase().includes("heurist")) {
      return res.status(400).json({ error: "invalid_name_or_symbol", message: "Cannot use 'heurist' in name or symbol" });
    }

    if (name.length > 32 || symbol.length > 10) {
      return res.status(400).json({ error: "name_or_symbol_too_long", message: "Name max 32 chars, symbol max 10 chars" });
    }

    const validSizes = ["TEST", "S", "L"];
    if (!validSizes.includes(size)) {
      return res.status(400).json({ error: "invalid_size", message: "Size must be TEST, S, or L" });
    }

    // Default creator to zero address for testing
    const creator = req.body?.creator?.toLowerCase() || "0x0000000000000000000000000000000000000000";

    const launchId = randomUUID();
    const metadataPayload = {
      name,
      symbol,
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
        x402Nonce: `test-${randomUUID()}`, // Generate a test nonce
        contractUri: metadataUri,
        status: "queued"
      }
    });

    await enqueueJob("COIN", `test-coin:${launchId}`, {
      launchId: launch.id,
      name,
      symbol,
      size,
      creator,
      metadataUri
    }, undefined, 1);

    res.json({
      ok: true,
      reference: launch.id,
      metadataUri,
      notes: "The token will be created shortly. You can call /x402/coin_status to check the status."
    });
  } catch (err) {
    log.error({ err }, "POST /internal/createCoin failed");
    res.status(500).json({
      error: "internal_error",
      message: "Failed to create test token"
    });
  }
});

const INTERNAL_PORT = process.env.INTERNAL_PORT || 8081;

app.listen(INTERNAL_PORT, () => {
  log.info(`Internal API (localhost-only) on :${INTERNAL_PORT}`);
});
