import { createHmac } from "node:crypto";
import { signBody, verifySignature } from "./webhook-signature";

describe("webhook signature", () => {
  const body = '{"id":"e1","event":"deposit.confirmed"}';

  it("is the hex HMAC-SHA256 of the exact body, the scheme receivers already verify", () => {
    const expected = createHmac("sha256", "s3cret").update(body).digest("hex");

    expect(signBody("s3cret", body)).toBe(expected);
  });

  it("changes when a single byte of the body changes", () => {
    expect(signBody("s3cret", body)).not.toBe(signBody("s3cret", `${body} `));
  });

  it("changes with the secret", () => {
    expect(signBody("a", body)).not.toBe(signBody("b", body));
  });

  it("verifies a good signature and rejects a bad one", () => {
    const signature = signBody("s3cret", body);

    expect(verifySignature("s3cret", body, signature)).toBe(true);
    expect(verifySignature("s3cret", body, "0".repeat(64))).toBe(false);
    expect(verifySignature("other", body, signature)).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifySignature("s3cret", body, "abc")).toBe(false);
  });
});
