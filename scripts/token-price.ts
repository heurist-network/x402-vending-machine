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
 *   bun run token-price-engine.ts                  # HEU price only
 *   bun run token-price-engine.ts <tokenAddress>   # Token price
 *
 * Requires: RPC_URL_BASE environment variable (archive node for historical blocks)
 */

import { ethers } from "ethers";

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

interface TokenPrice {
  tokenAddress: string;
  priceInHEU: number;
  priceInUSD: number;
}

interface TokenPriceResult {
  current: TokenPrice;
  oneHourAgo: TokenPrice;
  oneDayAgo: TokenPrice;
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
 * Eliminates need for on-chain getPair() call.
 */
function computePairAddress(tokenA: string, tokenB: string): string {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = ethers.keccak256(ethers.solidityPacked(["address", "address"], [token0, token1]));
  return ethers.getCreate2Address(V2_FACTORY, salt, INIT_CODE_PAIR_HASH);
}

/**
 * Fetches HEU prices from CoinGecko API.
 * Returns current price and calculates historical prices using percentage changes.
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
 * Determines if token is token0 in the Uniswap V2 pair.
 * In Uniswap V2, token0 is always the address with smaller hex value.
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
 * Fetches pool reserves at 3 different blocks using Multicall3.
 * Queries current, 1 hour ago, and 24 hours ago blocks in parallel.
 */
async function getReservesMulticall(
  provider: ethers.JsonRpcProvider,
  pairAddress: string,
  tokenAddress: string,
  blocks: { current: number; oneHourAgo: number; oneDayAgo: number }
): Promise<{
  current: { tokenReserve: bigint; heuReserve: bigint };
  oneHourAgo: { tokenReserve: bigint; heuReserve: bigint };
  oneDayAgo: { tokenReserve: bigint; heuReserve: bigint };
}> {
  const pairInterface = new ethers.Interface(PAIR_ABI);
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const getReservesData = pairInterface.encodeFunctionData("getReserves");

  const calls = [
    { target: pairAddress, allowFailure: false, callData: getReservesData },
  ];

  const [currentRes, hourAgoRes, dayAgoRes] = await Promise.all([
    multicall.aggregate3(calls, { blockTag: blocks.current }),
    multicall.aggregate3(calls, { blockTag: blocks.oneHourAgo }),
    multicall.aggregate3(calls, { blockTag: blocks.oneDayAgo }),
  ]);

  const decodeReserves = (result: { success: boolean; returnData: string }) => {
    const decoded = pairInterface.decodeFunctionResult("getReserves", result.returnData);
    return [decoded[0], decoded[1], decoded[2]] as [bigint, bigint, number];
  };

  return {
    current: parseReserves(decodeReserves(currentRes[0]), tokenAddress),
    oneHourAgo: parseReserves(decodeReserves(hourAgoRes[0]), tokenAddress),
    oneDayAgo: parseReserves(decodeReserves(dayAgoRes[0]), tokenAddress),
  };
}

/**
 * Calculates token price from pool reserves.
 * Formula: tokenPriceInHEU = heuReserve / tokenReserve
 */
function calculateTokenPrice(
  tokenReserve: bigint,
  heuReserve: bigint,
  heuUsdPrice: number
): { priceInHEU: number; priceInUSD: number } {
  if (tokenReserve === 0n) {
    return { priceInHEU: 0, priceInUSD: 0 };
  }

  const priceInHEU = Number(heuReserve) / Number(tokenReserve);
  const priceInUSD = priceInHEU * heuUsdPrice;

  return { priceInHEU, priceInUSD };
}

/**
 * Main function to get token prices at current, 1h ago, and 24h ago.
 * Combines on-chain pool reserves with CoinGecko HEU price.
 */
async function getTokenPrices(tokenAddress: string): Promise<TokenPriceResult> {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL_BASE);

  const pairAddress = computePairAddress(tokenAddress, HEU_ADDRESS);
  const currentBlock = await provider.getBlockNumber();

  const blocks = {
    current: currentBlock,
    oneHourAgo: currentBlock - BLOCKS_PER_HOUR,
    oneDayAgo: currentBlock - BLOCKS_PER_DAY,
  };

  const [heuPrices, reserves] = await Promise.all([
    getHEUPrices(),
    getReservesMulticall(provider, pairAddress, tokenAddress, blocks),
  ]);

  return {
    current: {
      tokenAddress,
      ...calculateTokenPrice(reserves.current.tokenReserve, reserves.current.heuReserve, heuPrices.current),
    },
    oneHourAgo: {
      tokenAddress,
      ...calculateTokenPrice(reserves.oneHourAgo.tokenReserve, reserves.oneHourAgo.heuReserve, heuPrices.oneHourAgo),
    },
    oneDayAgo: {
      tokenAddress,
      ...calculateTokenPrice(reserves.oneDayAgo.tokenReserve, reserves.oneDayAgo.heuReserve, heuPrices.oneDayAgo),
    },
  };
}

async function main() {
  const startTime = Date.now();
  const tokenAddress = process.argv[2];

  if (!tokenAddress) {
    const heuPrices = await getHEUPrices();
    const duration = Date.now() - startTime;
    console.log(
      JSON.stringify(
        {
          token: "HEU",
          current_price_usd: heuPrices.current,
          "1_hour_ago_price_usd": heuPrices.oneHourAgo,
          "1_day_ago_price_usd": heuPrices.oneDayAgo,
          _meta: { duration_ms: duration },
        },
        null,
        2
      )
    );
    return;
  }

  if (!process.env.RPC_URL_BASE) {
    console.error("RPC_URL_BASE environment variable required for token prices");
    process.exit(1);
  }

  const result = await getTokenPrices(tokenAddress);
  const duration = Date.now() - startTime;

  console.log(
    JSON.stringify(
      {
        tokenAddress,
        current_price_usd: result.current.priceInUSD.toFixed(18),
        "1_hour_ago_price_usd": result.oneHourAgo.priceInUSD.toFixed(18),
        "1_day_ago_price_usd": result.oneDayAgo.priceInUSD.toFixed(18),
        current_price_heu: result.current.priceInHEU.toFixed(18),
        "1_hour_ago_price_heu": result.oneHourAgo.priceInHEU.toFixed(18),
        "1_day_ago_price_heu": result.oneDayAgo.priceInHEU.toFixed(18),
        _meta: { duration_ms: duration },
      },
      null,
      2
    )
  );
}

main().catch(console.error);

export { getTokenPrices, getHEUPrices, type TokenPriceResult, type HEUPrices };
