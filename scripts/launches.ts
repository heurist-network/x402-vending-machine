import { argString, createPaymentFetch, decodePaymentResponse, getAccountFromEnv, getApiBaseUrl, log, parseArgs, safeJson } from "./script-utils";

async function main() {
  const args = parseArgs();
  const account = getAccountFromEnv(process.env.STATUS_PRIVATE_KEY_ENV || "PRIVATE_KEY");
  log.info({ address: account.address }, "Using wallet");

  const fetchWithPayment = createPaymentFetch(account);
  const baseUrl = getApiBaseUrl(argString(args, "api"));
  const filter = argString(args, "filter") || process.env.LAUNCHES_FILTER || undefined;

  const body: any = {};
  if (filter) {
    body.filter = filter;
  }

  log.info({ filter: filter || "all" }, "Calling /launches");

  const response = await fetchWithPayment(`${baseUrl}/launches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);

  if (!response.ok) {
    log.error({ status: response.status, payload }, "launches request failed");
    process.exit(1);
  }

  log.info(`result: ${JSON.stringify(payload, null, 2)}`);
}

main().catch((err) => {
  log.error({ err }, "launches script error");
  process.exit(1);
});
