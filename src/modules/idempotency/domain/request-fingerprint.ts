import { createHash } from "node:crypto";

export interface FingerprintInput {
  method: string;
  route: string;
  body: unknown;
}

/** Deterministic serialisation: object keys sorted, arrays keep their order. */
function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    );

  return `{${entries.join(",")}}`;
}

/** SHA-256 of method + route + canonical body, as hex. */
export function fingerprint({ method, route, body }: FingerprintInput): string {
  return createHash("sha256")
    .update(JSON.stringify([method, route, canonical(body)]))
    .digest("hex");
}
