import { argBoolean, argString, createPaymentFetch, decodePaymentResponse, getAccountFromEnv, getApiBaseUrl, log, parseArgs, requireEnv, safeJson } from "./script-utils";

function resolveRoute(opts: { amount?: string; route?: string; test?: boolean, half?: boolean }) {
  if (opts.test) return "buyTest";
  if (opts.half) return "buyHalf";
  if (opts.route) return opts.route;
  if (!opts.amount) return "buy";
  const normalized = opts.amount.toLowerCase();
  if (normalized === "1" || normalized === "buy") return "buy";
  if (normalized === "10" || normalized === "10x") return "buy10x";
  if (normalized === "test" || normalized === "buytest") return "buyTest";
  throw new Error(`Unsupported amount "${opts.amount}". Use 1, 10, or test.`);
}

async function main() {
  const args = parseArgs();
  const account = getAccountFromEnv(process.env.BUY_PRIVATE_KEY_ENV || "PRIVATE_KEY");
  log.info({ address: account.address }, "Using buyer wallet");

  const fetchWithPayment = createPaymentFetch(account);
  const baseUrl = getApiBaseUrl();

  const token = (argString(args, "token") || process.env.BUY_TOKEN || requireEnv("BUY_TOKEN")).toLowerCase();
  const recipient = argString(args, "recipient") || process.env.BUY_RECIPIENT || undefined;
  const route = resolveRoute({
    amount: argString(args, "amount") || process.env.BUY_AMOUNT,
    route: argString(args, "route") || process.env.BUY_ROUTE,
    test: argBoolean(args, "test"),
    half: argBoolean(args, "half")
  });

  const endpoint = `${baseUrl}/x402/${route}`;
  const body = { token, recipient };

  log.info({ endpoint, token, recipient, route }, "Submitting buy request");

  const response = await fetchWithPayment(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);
  const payment = decodePaymentResponse(response);

  if (!response.ok) {
    log.error({ status: response.status, payload }, "Buy request failed");
    process.exit(1);
  }

  log.info(`result: ${JSON.stringify(payload)}`);
}

main().catch((err) => {
  log.error({ err }, "buy-token script error");
  process.exit(1);
});
