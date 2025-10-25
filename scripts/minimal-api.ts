import express from "express";
import { facilitator } from "@coinbase/x402";
import { paymentMiddleware } from "x402-express";
import { processPriceToAtomicAmount } from "x402/shared";
import { parseXPayment } from "../src/xpay";

const app = express();
app.use(express.json());

const PAY_TO = '0x7d9d1821d15B9e0b8Ab98A058361233E255E405D'

const NETWORK = "base";
const PRICE = "$0.01";
const PORT = Number.parseInt(process.env.PORT ?? "4025", 10);

app.use(
  paymentMiddleware(
    PAY_TO as `0x${string}`,
    {
      "POST /demo": {
        price: PRICE,
        network: NETWORK,
        config: {
          description: "Minimal x402 demo endpoint that validates payer and amount.",
        },
      },
    },
    facilitator,
  ),
);

app.get("/", (_req, res) => {
  res.json({
    message: "Use POST /demo with a valid X-PAYMENT header to test the flow.",
    network: NETWORK,
    price: PRICE,
    payTo: PAY_TO,
  });
});

app.post("/demo", (req, res) => {
  const header = req.get("x-payment");
  if (!header) {
    return res.status(400).json({ ok: false, error: "missing_x_payment_header" });
  }

  let parsed;
  try {
    parsed = parseXPayment(header);
    console.log("parsed", parsed);
  } catch (error) {
    return res.status(400).json({ ok: false, error: "invalid_payment_header", details: String(error) });
  }

  if (!parsed.payer) {
    return res.status(400).json({ ok: false, error: "payer_not_found" });
  }

  const atomicAmount = processPriceToAtomicAmount(PRICE, NETWORK);
  if ("error" in atomicAmount) {
    return res.status(500).json({ ok: false, error: atomicAmount.error });
  }

  const expectedValue = BigInt(atomicAmount.maxAmountRequired);
  if (parsed.value !== expectedValue) {
    return res.status(402).json({
      ok: false,
      error: "incorrect_amount",
      expectedAtomic: expectedValue.toString(),
      receivedAtomic: parsed.value.toString(),
    });
  }

  return res.json({
    ok: true,
    payer: parsed.payer,
    usdcAtomic: parsed.value.toString(),
    message: "x402 payment verified and amount matches expected USDC charge.",
  });
});

app.listen(PORT, () => {
  console.log(`Minimal x402 API listening on http://localhost:${PORT}`);
  console.log(`Expecting ${PRICE} on ${NETWORK} paid to ${PAY_TO}`);
});
