import { ethers } from "ethers";

export function verifyUpdateSignature(
  signer: string,
  tokenLower: string,
  updatable: any,
  signature: string
): boolean {
  const message = JSON.stringify({
    token: tokenLower,
    ...updatable
  });

  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === signer.toLowerCase();
  } catch {
    return false;
  }
}
