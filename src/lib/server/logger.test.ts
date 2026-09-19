import { beforeEach, describe, expect, it, vi } from "vitest";
import { logServerError } from "./logger";

describe("server logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only safe error metadata", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const secret = new Error("API_KEY=super-secret-value");

    logServerError("provider_request_failed", secret, {
      provider: "test-provider",
      status: 502,
    });

    expect(spy).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;

    expect(payload.level).toBe("error");
    expect(payload.event).toBe("provider_request_failed");
    expect(payload.provider).toBe("test-provider");
    expect(payload.status).toBe(502);
    expect(payload.error).toEqual({ name: "Error" });
    expect(String(spy.mock.calls[0][0])).not.toContain("super-secret-value");
  });

  it("never serializes arbitrary error objects", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logServerError("unexpected_failure", {
      prompt: "private user content",
      token: "secret",
    });

    expect(String(spy.mock.calls[0][0])).not.toContain("private user content");
    expect(String(spy.mock.calls[0][0])).not.toContain("secret");
  });
});
