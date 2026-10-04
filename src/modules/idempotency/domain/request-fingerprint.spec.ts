import { fingerprint } from "./request-fingerprint";

const base = {
  method: "POST",
  route: "/wallet/deposit",
  body: { amount: "500", currency: "ARS" },
};

describe("fingerprint", () => {
  it("is stable for the same request", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it("is a SHA-256 in hex", () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order of the fields", () => {
    const reordered = { ...base, body: { currency: "ARS", amount: "500" } };

    expect(fingerprint(reordered)).toBe(fingerprint(base));
  });

  it("does not depend on the order of nested fields", () => {
    const a = { ...base, body: { meta: { x: 1, y: 2 }, amount: "1" } };
    const b = { ...base, body: { amount: "1", meta: { y: 2, x: 1 } } };

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("changes with the amount", () => {
    expect(
      fingerprint({ ...base, body: { amount: "900", currency: "ARS" } }),
    ).not.toBe(fingerprint(base));
  });

  it("changes with the method and with the route", () => {
    expect(fingerprint({ ...base, method: "PUT" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, route: "/wallet/withdraw" })).not.toBe(
      fingerprint(base),
    );
  });

  it("keeps the order of array elements significant", () => {
    const a = { ...base, body: { items: [1, 2] } };
    const b = { ...base, body: { items: [2, 1] } };

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("tells a string from a number", () => {
    expect(fingerprint({ ...base, body: { amount: "500" } })).not.toBe(
      fingerprint({ ...base, body: { amount: 500 } }),
    );
  });

  it("tells a missing body from an empty one", () => {
    expect(fingerprint({ ...base, body: undefined })).not.toBe(
      fingerprint({ ...base, body: {} }),
    );
  });

  it("separates fields that could be confused when concatenated", () => {
    expect(fingerprint({ method: "POST", route: "/a", body: "b" })).not.toBe(
      fingerprint({ method: "POST", route: "/ab", body: "" }),
    );
  });
});
