import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

async function main() {
  // Load private key from environment variable
  // Expects PRIVATE_KEY in .env (with or without 0x prefix)
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  // Create account from private key
  const account = privateKeyToAccount(
    privateKey.startsWith("0x") ? privateKey as `0x${string}` : `0x${privateKey}` as `0x${string}`
  );

  log.info({ address: account.address }, "Using account");

  // Wrap fetch with x402 payment capability
  const fetchWithPayment = wrapFetchWithPayment(fetch, account);

  // Call the x402 endpoint
  const url = "http://localhost:8080/demo";
  log.info({ url }, "Making x402 request");

  try {
    const response = await fetchWithPayment(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Get the response body
    const body = await response.json();
    log.info({ body }, "Response body");

    // Decode and display payment information
    const paymentResponseHeader = response.headers.get("x-payment-response");
    if (paymentResponseHeader) {
      const paymentResponse = decodeXPaymentResponse(paymentResponseHeader);
      log.info({ paymentResponse }, "Payment details");
    }

    log.info("✅ x402 payment flow completed successfully!");
  } catch (error) {
    log.error({ err: error }, "❌ x402 payment flow failed");
    process.exit(1);
  }
}

main();
