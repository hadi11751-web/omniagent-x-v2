import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectText } from "@/lib/stream";
import { startMockNexusUpstream, type MockNexusUpstream } from "../../test/helpers/mockNexusUpstream";

describe("collectText (planner, verifier, memory)", () => {
  let up: MockNexusUpstream;
  beforeAll(async () => { up = await startMockNexusUpstream(); });
  afterAll(() => up.close());
  beforeEach(() => {
    up.reset();
    vi.stubEnv("NEXUS_BASE_URL", up.url);
    vi.stubEnv("NEXUS_MODEL", "engine");
    vi.stubEnv("NEXUS_API_KEY", "k");
    vi.stubEnv("NEXUS_EXECUTION", "cloud");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("joins streamed chunks and trims", async () => {
    up.enqueue({ kind: "text", chunks: ["  a", "b "] });
    expect(await collectText([{ role: "user", content: "x" }])).toBe("ab");
  });

  it("retries transient errors against the same single backend", async () => {
    up.enqueue({ kind: "http", status: 503, body: "{}" }, { kind: "text", chunks: ["fine"] });
    expect(await collectText([{ role: "user", content: "x" }])).toBe("fine");
    expect(up.calls).toHaveLength(2);
  });
});
