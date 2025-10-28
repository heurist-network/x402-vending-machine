import { argString, createPaymentFetch, decodePaymentResponse, getAccountFromEnv, getApiBaseUrl, log, parseArgs, requireEnv, safeJson } from "./script-utils";

async function main() {
  const args = parseArgs();
  const account = getAccountFromEnv(process.env.STATUS_PRIVATE_KEY_ENV || "PRIVATE_KEY");
  log.info({ address: account.address }, "Using status wallet");

  const fetchWithPayment = createPaymentFetch(account);
  const baseUrl = getApiBaseUrl();
  const reference = argString(args, "reference") || process.env.COIN_REFERENCE || requireEnv("COIN_REFERENCE");

  log.info({ reference }, "Checking /coin_status");

  const response = await fetchWithPayment(`${baseUrl}/x402/coin_status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference })
  });

  const payload = await safeJson(response);
  const payment = decodePaymentResponse(response);

  if (!response.ok) {
    log.error({ status: response.status, payload }, "coin_status request failed");
    process.exit(1);
  }

  //log.info({ payload, payment }, "Coin status");
  log.info(`result: ${JSON.stringify(payload)}`);
}

main().catch((err) => {
  log.error({ err }, "coin-status script error");
  process.exit(1);
});
