import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImage, generateImageTool } from "./generateImage";

const originalKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();

  if (originalKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalKey;
  }
});

describe("generateImage", () => {
  it("fails clearly when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;

    await expect(
      generateImage("a realistic Bugatti"),
    ).rejects.toThrow("GEMINI_API_KEY is not configured");
  });

  it("requests an image from Gemini and returns a data URL", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_image: {
            data: "AQID",
            mime_type: "image/png",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage("a realistic Bugatti");

    expect(result).toBe("data:image/png;base64,AQID");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];

    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(options.method).toBe("POST");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");

    const body = JSON.parse(options.body);

    expect(body.model).toBe("gemini-3.1-flash-image");
    expect(body.input).toBe("a realistic Bugatti");
    expect(body.response_format.type).toBe("image");
    expect(body.response_format.image_size).toBe("1K");
  });

  it("handles Gemini authentication errors", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "API key not valid",
            },
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    );

    await expect(
      generateImage("a realistic Bugatti"),
    ).rejects.toThrow(
      "Gemini image generation authentication failed (403)",
    );
  });

  it("returns a failed tool result for an empty prompt", async () => {
    const result = await generateImageTool.run("   ");

    expect(result.ok).toBe(false);
    expect(result.content).toContain("image prompt is empty");
  });
});
