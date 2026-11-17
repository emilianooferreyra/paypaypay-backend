import { classifyFailure } from "./classify-failure";

describe("classifyFailure", () => {
  it("stores a business answer that is deterministic for the request", () => {
    expect(classifyFailure(404)).toBe("fail");
    expect(classifyFailure(422)).toBe("fail");
  });

  it("discards the claim when the input was invalid, so the key can be reused", () => {
    expect(classifyFailure(400)).toBe("discard");
  });

  it("releases the lease for a conflict, a server error or no status at all", () => {
    expect(classifyFailure(409)).toBe("unlock");
    expect(classifyFailure(500)).toBe("unlock");
    expect(classifyFailure(502)).toBe("unlock");
    expect(classifyFailure(503)).toBe("unlock");
    expect(classifyFailure(undefined)).toBe("unlock");
  });

  it("treats any other status as transient rather than guessing it is permanent", () => {
    expect(classifyFailure(418)).toBe("unlock");
    expect(classifyFailure(429)).toBe("unlock");
  });
});
