import { argString, createPaymentFetch, decodePaymentResponse, getAccountFromEnv, getApiBaseUrl, log, parseArgs, requireEnv, safeJson } from "./script-utils";

async function main() {
  const args = parseArgs();
  const account = getAccountFromEnv(process.env.STATUS_PRIVATE_KEY_ENV || "PRIVATE_KEY");
  log.info({ address: account.address }, "Using wallet");

  const fetchWithPayment = createPaymentFetch(account);
  const baseUrl = getApiBaseUrl(argString(args, "api"));
  const token = argString(args, "token") || process.env.TOKEN_ADDRESS || requireEnv("TOKEN_ADDRESS");

  // Build metadata update payload
  const body: any = { token };

  // Optional metadata fields
  const imageUrl = argString(args, "image-url") || process.env.IMAGE_URL;
  const website = argString(args, "website") || process.env.WEBSITE;
  const docs = argString(args, "docs") || process.env.DOCS;
  const twitter = argString(args, "twitter") || process.env.TWITTER;
  const telegram = argString(args, "telegram") || process.env.TELEGRAM;
  const discord = argString(args, "discord") || process.env.DISCORD;
  const description = argString(args, "description") || process.env.DESCRIPTION;

  if (imageUrl !== undefined) body.imageUrl = imageUrl;
  if (website !== undefined) body.website = website;
  if (docs !== undefined) body.docs = docs;
  if (twitter !== undefined) body.twitter = twitter;
  if (telegram !== undefined) body.telegram = telegram;
  if (discord !== undefined) body.discord = discord;
  if (description !== undefined) body.description = description;

  // Check if at least one metadata field is being updated
  const hasUpdates = imageUrl !== undefined || website !== undefined || docs !== undefined ||
    twitter !== undefined || telegram !== undefined || discord !== undefined || description !== undefined;

  if (!hasUpdates) {
    log.error("No metadata fields to update. Provide at least one of: --image-url, --website, --docs, --twitter, --telegram, --discord, --description");
    process.exit(1);
  }

  log.info({ token, updates: Object.keys(body).filter(k => k !== "token") }, "Calling /metadata/update");

  const response = await fetchWithPayment(`${baseUrl}/metadata/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);

  if (!response.ok) {
    log.error({ status: response.status, payload }, "metadata/update request failed");
    process.exit(1);
  }

  log.info(`result: ${JSON.stringify(payload, null, 2)}`);
}

main().catch((err) => {
  log.error({ err }, "metadata-update script error");
  process.exit(1);
});
