import { exact } from "x402/schemes";
import type { ExactEvmPayload, PaymentPayload } from "x402/types";

type ParsedPayment = { payer?: string; value: bigint; nonce?: string };

export function parseXPayment(header: string): ParsedPayment {
  try {
    const payment = exact.evm.decodePayment(header) as PaymentPayload;
    const auth = (payment.payload as ExactEvmPayload).authorization;
    return {
      payer: auth.from,
      value: BigInt(auth.value),
      nonce: auth.nonce,
    };
  } catch (primaryError) {
    let obj: any;
    try {
      obj = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      try {
        obj = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
      } catch {
        if (typeof header === "string") {
          obj = JSON.parse(header);
        } else {
          throw primaryError;
        }
      }
    }
    const auth = obj?.payload?.authorization ?? {};
    const value = typeof auth.value === "string" ? BigInt(auth.value) : 0n;
    return { payer: toLowerAddr(auth.from), value, nonce: auth.nonce };
  }
}

export function toLowerAddr(addr: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error("invalid_address");
  return addr.toLowerCase();
}
