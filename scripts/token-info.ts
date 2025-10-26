import { argString, createPaymentFetch, decodePaymentResponse, getAccountFromEnv, getApiBaseUrl, log, parseArgs, requireEnv, safeJson } from "./script-utils";

async function main() {
  const args = parseArgs();
  const account = getAccountFromEnv(process.env.STATUS_PRIVATE_KEY_ENV || "PRIVATE_KEY");
  log.info({ address: account.address }, "Using wallet");

  const fetchWithPayment = createPaymentFetch(account);
  const baseUrl = getApiBaseUrl(argString(args, "api"));
  const token = argString(args, "token") || process.env.TOKEN_ADDRESS || requireEnv("TOKEN_ADDRESS");

  log.info({ token }, "Calling /token_info");

  const response = await fetchWithPayment(`${baseUrl}/token_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });

  const payload = await safeJson(response);

  if (!response.ok) {
    log.error({ status: response.status, payload }, "token_info request failed");
    process.exit(1);
  }

  log.info(`result: ${JSON.stringify(payload, null, 2)}`);
}

main().catch((err) => {
  log.error({ err }, "token-info script error");
  process.exit(1);
});
