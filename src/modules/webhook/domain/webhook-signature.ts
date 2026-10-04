import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hex HMAC-SHA256 of the exact bytes sent. This is the scheme receivers already
 * verify (`X-Webhook-Signature`); changing what is signed would break them, so
 * a replay-protected version is a separate, versioned change.
 */
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signBody(secret, body), "hex");
  const received = Buffer.from(signature, "hex");

  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
