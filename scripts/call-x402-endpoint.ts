import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

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

  console.log("Using account:", account.address);

  // Wrap fetch with x402 payment capability
  const fetchWithPayment = wrapFetchWithPayment(fetch, account);

  // Call the x402 endpoint
  const url = "http://localhost:8080/demo";
  console.log(`Making x402 request to ${url}...`);

  try {
    const response = await fetchWithPayment(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Get the response body
    const body = await response.json();
    console.log("\nResponse body:", JSON.stringify(body, null, 2));

    // Decode and display payment information
    const paymentResponseHeader = response.headers.get("x-payment-response");
    if (paymentResponseHeader) {
      const paymentResponse = decodeXPaymentResponse(paymentResponseHeader);
      console.log("\nPayment details:", JSON.stringify(paymentResponse, null, 2));
    }

    console.log("\n✅ x402 payment flow completed successfully!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();
