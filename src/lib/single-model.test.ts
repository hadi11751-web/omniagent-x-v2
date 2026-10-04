import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(join(root, "src")).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f),
);
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(root, f);

/** Comments may discuss history; code and user-facing strings may not. */
function stripComments(code: string) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("there is exactly one AI model: Nexus", () => {
  it("has no router, model selection, or multi-provider directory", () => {
    for (const gone of [
      "src/lib/router.ts",
      "src/lib/model-selection.ts",
      "src/lib/providers",
      "src/lib/providers/index.ts",
    ]) {
      expect(existsSync(join(root, gone)), gone).toBe(false);
    }
  });

  it("contains no routing, failover or model-picking code", () => {
    const banned =
      /\b(routeModel|selectModel|availableModels|providerFor|PROVIDERS|rankFailoverCandidates|streamWithFailover|blendParticipants|boundaryPool|runBlend|nexusBackendFor)\b/;
    const hits = sources
      .filter((f) => banned.test(stripComments(read(f))))
      .map(rel);

    expect(hits).toEqual([]);
  });

  it("mentions the old autoRoute setting only to discard it during migration", () => {
    const hits = sources
      .filter((f) => /\bautoRoute\b/.test(stripComments(read(f))))
      .map(rel);

    expect(hits.map((value) => value.replace(/\\/g, "/"))).toEqual(["src/lib/client/storage.ts"]);
  });

  it("never reads a model choice out of a request body", () => {
    const route = stripComments(read(join(root, "src/app/api/chat/route.ts")));
    expect(route).not.toMatch(/body\.model\b/);
    expect(route).not.toMatch(/modelId/);
  });

  it("names no other AI vendor or model anywhere a user can read it", () => {
    const vendors = /OpenAI|Anthropic|Claude|ChatGPT|\bGPT\b|Grok|DeepSeek|Perplexity|Sonar|Llama|Qwen|Mistral|Ollama|Hugging ?Face/i;
    const userFacing = sources.filter(
      (f) =>
        /src\/(components|app\/pricing)\//.test(f) ||
        /src\/lib\/(product|models|privacy|client\/.*)\.ts$/.test(f) ||
        f.endsWith("src/app/layout.tsx") ||
        f.endsWith("src/app/page.tsx"),
    );
    const hits = userFacing
      .filter((f) => vendors.test(stripComments(read(f))))
      .map(rel);

    expect(hits).toEqual([]);
  });

  it("builds the only chat provider from NEXUS_* variables and no vendor key", () => {
    const keys = /(OPENAI|ANTHROPIC|XAI|DEEPSEEK|PERPLEXITY|OPENROUTER|HUGGINGFACE|OLLAMA)_(API_KEY|BASE_URL)|GROQ_API_KEY.*chat/;
    const hits = sources.filter((f) => keys.test(stripComments(read(f)))).map(rel);
    expect(hits).toEqual([]);
    expect(read(join(root, "src/lib/nexus.ts"))).toContain("NEXUS_MODEL");
  });
});

describe("GET /api/status", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports readiness and never the engine, endpoint, or key behind Nexus", async () => {
    vi.stubEnv("NEXUS_MODEL", "super-secret-engine-9000");
    vi.stubEnv("NEXUS_API_KEY", "sk-very-secret");
    vi.stubEnv("NEXUS_BASE_URL", "https://engine-vendor.example/v1");
    vi.stubEnv("NEXUS_VISION", "true");

    const { GET } = await import("@/app/api/status/route");
    const body = await (GET() as Response).json();
    const blob = JSON.stringify(body);

    expect(body.nexus).toEqual({ label: "Nexus", ready: true, vision: true, execution: "cloud" });
    expect(body).not.toHaveProperty("models");
    expect(body).not.toHaveProperty("providers");
    expect(blob).not.toMatch(/super-secret|9000|very-secret|engine-vendor/);
  });

  it("says Nexus is not ready when unconfigured", async () => {
    vi.stubEnv("NEXUS_MODEL", "");

    const { GET } = await import("@/app/api/status/route");
    const body = await (GET() as Response).json();

    expect(body.nexus.ready).toBe(false);
    expect(body.visionInput).toBe(false);
  });
});
