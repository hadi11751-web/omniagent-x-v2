import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImage, generateImageTool } from "./generateImage";

const originalKey = process.env.POLLINATIONS_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();

  if (originalKey === undefined) {
    delete process.env.POLLINATIONS_API_KEY;
  } else {
    process.env.POLLINATIONS_API_KEY = originalKey;
  }
});

describe("generateImage", () => {
  it("fails clearly when POLLINATIONS_API_KEY is missing", async () => {
    delete process.env.POLLINATIONS_API_KEY;

    await expect(
      generateImage("a realistic Bugatti"),
    ).rejects.toThrow("POLLINATIONS_API_KEY is not configured");
  });

  it("requests an image from Pollinations and returns a data URL", async () => {
    process.env.POLLINATIONS_API_KEY = "test-key";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "image/png",
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage("a realistic Bugatti");

    expect(result).toBe("data:image/png;base64,AQID");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];

    expect(String(url)).toContain(
      "https://gen.pollinations.ai/image/a%20realistic%20Bugatti?model=flux",
    );
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(options.headers.Accept).toBe("image/*");
  });

  it("returns a failed tool result for an empty prompt", async () => {
    const result = await generateImageTool.run("   ");

    expect(result.ok).toBe(false);
    expect(result.content).toContain("image prompt is empty");
  });
});
