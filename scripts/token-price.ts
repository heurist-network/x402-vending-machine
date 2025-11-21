/**
 * Token Price Engine
 *
 * Calculates token prices in USD and HEU for graduated tokens on Base chain.
 *
 * Formula:
 *   tokenPriceInHEU = heuReserve / tokenReserve (from Uniswap V2 pool)
 *   tokenPriceInUSD = tokenPriceInHEU × heuPriceUSD (from CoinGecko)
 *
 * Usage:
 *   bun run token-price.ts                     # All graduated tokens from BFF
 *   bun run token-price.ts <tokenAddress>      # Single token price
 *
 * Requires: RPC_URL_BASE environment variable (archive node for historical blocks)
 */

import { ethers } from "ethers";

const BFF_URL = process.env.BFF_URL || "http://34.10.4.155:8081";
const COINGECKO_API = "https://api.coingecko.com/api/v3";
const HEU_ADDRESS = "0xEF22cb48B8483dF6152e1423b19dF5553BbD818b";
const V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const INIT_CODE_PAIR_HASH = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
];

const BLOCKS_PER_HOUR = 1800;
const BLOCKS_PER_DAY = 43200;

interface HEUPrices {
  current: number;
  oneHourAgo: number;
  oneDayAgo: number;
}

interface TokenMcapResult {
  tokenAddress: string;
  current_mcap_usd: string;
  "1_hour_ago_mcap_usd": string;
  "1_day_ago_mcap_usd": string;
}

/**
 * Sorts two token addresses for Uniswap V2 pair creation.
 */
function sortTokens(a: string, b: string): [string, string] {
  const tokenA = ethers.getAddress(a);
  const tokenB = ethers.getAddress(b);
  return BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Computes Uniswap V2 pair address deterministically using CREATE2.
 */
function computePairAddress(tokenA: string, tokenB: string): string {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = ethers.keccak256(ethers.solidityPacked(["address", "address"], [token0, token1]));
  return ethers.getCreate2Address(V2_FACTORY, salt, INIT_CODE_PAIR_HASH);
}

/**
 * Fetches HEU prices from CoinGecko API.
 */
async function getHEUPrices(): Promise<HEUPrices> {
  const res = await fetch(
    `${COINGECKO_API}/coins/heurist?localization=false&tickers=false&community_data=false&developer_data=false`
  );
  const data = await res.json();
  const m = data.market_data;

  const current = m.current_price.usd;
  const change1h = m.price_change_percentage_1h_in_currency?.usd || 0;
  const change24h = m.price_change_percentage_24h || 0;

  return {
    current,
    oneHourAgo: current / (1 + change1h / 100),
    oneDayAgo: current / (1 + change24h / 100),
  };
}

/**
 * Fetches graduated token addresses from BFF API.
 */
async function fetchGraduatedTokens(): Promise<string[]> {
  const res = await fetch(`${BFF_URL}/v1/launches?filter=graduated`);
  const data = await res.json();
  return data.data.map((launch: { tokenAddress: string }) => launch.tokenAddress);
}

/**
 * Determines if token is token0 in the Uniswap V2 pair.
 */
function isTokenZero(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() < HEU_ADDRESS.toLowerCase();
}

/**
 * Parses raw reserves from getReserves() into tokenReserve and heuReserve.
 */
function parseReserves(
  reserves: [bigint, bigint, number],
  tokenAddress: string
): { tokenReserve: bigint; heuReserve: bigint } {
  const isToken0 = isTokenZero(tokenAddress);
  return {
    tokenReserve: isToken0 ? reserves[0] : reserves[1],
    heuReserve: isToken0 ? reserves[1] : reserves[0],
  };
}

/**
 * Batched multicall for multiple tokens at a specific block.
 * Returns reserves for all tokens in a single RPC call.
 */
async function getBatchedReserves(
  multicall: ethers.Contract,
  pairInterface: ethers.Interface,
  tokens: string[],
  blockTag: number
): Promise<Map<string, { tokenReserve: bigint; heuReserve: bigint }>> {
  const getReservesData = pairInterface.encodeFunctionData("getReserves");

  const calls = tokens.map((token) => ({
    target: computePairAddress(token, HEU_ADDRESS),
    allowFailure: true,
    callData: getReservesData,
  }));

  const results = await multicall.aggregate3(calls, { blockTag });

  const reservesMap = new Map<string, { tokenReserve: bigint; heuReserve: bigint }>();

  for (let i = 0; i < tokens.length; i++) {
    const result = results[i];
    if (result.success) {
      const decoded = pairInterface.decodeFunctionResult("getReserves", result.returnData);
      const reserves = [decoded[0], decoded[1], decoded[2]] as [bigint, bigint, number];
      reservesMap.set(tokens[i].toLowerCase(), parseReserves(reserves, tokens[i]));
    }
  }

  return reservesMap;
}

const TOTAL_SUPPLY = 1_000_000_000;

/**
 * Calculates token mcap from pool reserves.
 * mcap = price × 1 billion (total supply)
 */
function calculateMcap(
  tokenReserve: bigint,
  heuReserve: bigint,
  heuUsdPrice: number
): number {
  if (tokenReserve === 0n) {
    return 0;
  }

  const priceInHEU = Number(heuReserve) / Number(tokenReserve);
  const priceInUSD = priceInHEU * heuUsdPrice;

  return priceInUSD * TOTAL_SUPPLY;
}

/**
 * Get mcap for multiple tokens using true batched multicall.
 * Only 3 RPC calls total regardless of token count.
 */
async function getBatchedTokenMcaps(tokens: string[]): Promise<TokenMcapResult[]> {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL_BASE);
  const pairInterface = new ethers.Interface(PAIR_ABI);
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);

  const currentBlock = await provider.getBlockNumber();
  const blocks = {
    current: currentBlock,
    oneHourAgo: currentBlock - BLOCKS_PER_HOUR,
    oneDayAgo: currentBlock - BLOCKS_PER_DAY,
  };

  const [heuPrices, currentReserves, hourAgoReserves, dayAgoReserves] = await Promise.all([
    getHEUPrices(),
    getBatchedReserves(multicall, pairInterface, tokens, blocks.current),
    getBatchedReserves(multicall, pairInterface, tokens, blocks.oneHourAgo),
    getBatchedReserves(multicall, pairInterface, tokens, blocks.oneDayAgo),
  ]);

  return tokens.map((token) => {
    const tokenLower = token.toLowerCase();
    const current = currentReserves.get(tokenLower);
    const hourAgo = hourAgoReserves.get(tokenLower);
    const dayAgo = dayAgoReserves.get(tokenLower);

    const currentMcap = current
      ? calculateMcap(current.tokenReserve, current.heuReserve, heuPrices.current)
      : 0;

    const hourAgoMcap = hourAgo
      ? calculateMcap(hourAgo.tokenReserve, hourAgo.heuReserve, heuPrices.oneHourAgo)
      : 0;

    const dayAgoMcap = dayAgo
      ? calculateMcap(dayAgo.tokenReserve, dayAgo.heuReserve, heuPrices.oneDayAgo)
      : 0;

    return {
      tokenAddress: token,
      current_mcap_usd: currentMcap.toFixed(2),
      "1_hour_ago_mcap_usd": hourAgoMcap.toFixed(2),
      "1_day_ago_mcap_usd": dayAgoMcap.toFixed(2),
    };
  });
}

async function main() {
  const startTime = Date.now();
  const tokenAddress = process.argv[2];

  if (!process.env.RPC_URL_BASE) {
    console.error("RPC_URL_BASE environment variable required");
    process.exit(1);
  }

  let tokens: string[];

  if (tokenAddress) {
    tokens = [tokenAddress];
  } else {
    tokens = await fetchGraduatedTokens();
    console.error(`Fetched ${tokens.length} graduated tokens from BFF`);
  }

  const results = await getBatchedTokenMcaps(tokens);
  const duration = Date.now() - startTime;

  console.log(
    JSON.stringify(
      {
        mcaps: results,
        _meta: {
          token_count: tokens.length,
          duration_ms: duration,
        },
      },
      null,
      2
    )
  );
}

main().catch(console.error);

export { getBatchedTokenMcaps, getHEUPrices, fetchGraduatedTokens };
