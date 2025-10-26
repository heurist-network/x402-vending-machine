import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import pino from "pino";

export const log = pino({ level: process.env.SCRIPT_LOG_LEVEL || "info" });

export type ParsedArgs = Record<string, string | boolean>;

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      args[raw] = true;
      continue;
    }
    const trimmed = raw.slice(2);
    const equalIdx = trimmed.indexOf("=");
    if (equalIdx !== -1) {
      const key = trimmed.slice(0, equalIdx);
      const value = trimmed.slice(equalIdx + 1);
      args[key] = value;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[trimmed] = next;
      i++;
    } else {
      args[trimmed] = true;
    }
  }
  return args;
}

export function argString(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

export function argBoolean(args: ParsedArgs, key: string): boolean {
  const value = args[key];
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  return false;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getApiBaseUrl(override?: string): string {
  if (override) return override;
  return process.env.API_BASE_URL || "http://localhost:8080";
}

export function getAccountFromEnv(envName: string) {
  const raw = requireEnv(envName);
  const key = raw.startsWith("0x") ? (raw as `0x${string}`) : (`0x${raw}` as `0x${string}`);
  return privateKeyToAccount(key);
}

export function createPaymentFetch(account: ReturnType<typeof privateKeyToAccount>) {
  return wrapFetchWithPayment(fetch, account);
}

export async function safeJson<T = unknown>(response: Response): Promise<T | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function decodePaymentResponse(response: Response) {
  const header = response.headers.get("x-payment-response");
  if (!header) return null;
  try {
    return decodeXPaymentResponse(header);
  } catch (err) {
    log.warn({ err }, "Failed to decode x-payment-response header");
    return null;
  }
}

export function nowLabel() {
  return new Date().toISOString();
}
