import { argString, createPaymentFetch, decodePaymentResponse, getAccountFromEnv, getApiBaseUrl, log, parseArgs, safeJson } from "./script-utils";

async function main() {
  const args = parseArgs();
  const account = getAccountFromEnv(process.env.COIN_PRIVATE_KEY_ENV || "PRIVATE_KEY");
  log.info({ address: account.address }, "Using launcher wallet");

  const fetchWithPayment = createPaymentFetch(account);
  const baseUrl = getApiBaseUrl(argString(args, "api"));

  const name = argString(args, "name") || process.env.COIN_NAME || `Test Launch ${Date.now()}`;
  const symbol = (argString(args, "symbol") || process.env.COIN_SYMBOL || `T${Math.random().toString(36).substring(2, 6)}`).toUpperCase();
  const size = (argString(args, "size") || process.env.COIN_SIZE || "TEST").toUpperCase();

  const body = {
    name,
    symbol,
    size,
    creator: argString(args, "creator") || process.env.COIN_CREATOR || undefined,
    imageUrl: argString(args, "image") || process.env.COIN_IMAGE || undefined,
    website: argString(args, "website") || process.env.COIN_WEBSITE || undefined,
    docs: argString(args, "docs") || process.env.COIN_DOCS || undefined,
    twitter: argString(args, "twitter") || process.env.COIN_TWITTER || undefined,
    telegram: argString(args, "telegram") || process.env.COIN_TELEGRAM || undefined,
    discord: argString(args, "discord") || process.env.COIN_DISCORD || undefined,
    description: argString(args, "description") || process.env.COIN_DESCRIPTION || undefined
  };

  log.info({ baseUrl, size, name, symbol }, "Submitting /coin request");

  const response = await fetchWithPayment(`${baseUrl}/coin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);
  const payment = decodePaymentResponse(response);

  if (!response.ok) {
    log.error({ status: response.status, payload }, "Coin request failed");
    process.exit(1);
  }

  log.info(`result: ${JSON.stringify(payload)}`);
}

main().catch((err) => {
  log.error({ err }, "coin-test script error");
  process.exit(1);
});
