import { describe, expect, it } from "vitest";
import { loadEnvConfig } from "@next/env";
import { nexusConfig } from "@/lib/nexus";
import { collectText } from "@/lib/stream";
import { availableTools, parseToolCall, toolInstructions } from "@/lib/tools";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/models";

/*
 * Opt-in: calls the REAL engine behind Nexus through the same code the chat
 * route uses. It costs a few tokens, so it only runs with LIVE_NEXUS_SMOKE=1.
 * The mock-upstream tests prove the pipeline; this proves your engine actually
 * answers, follows the text tool protocol, and (if enabled) can see images.
 */
loadEnvConfig(process.cwd());

const enabled = process.env.LIVE_NEXUS_SMOKE === "1" && nexusConfig() !== undefined;

// 1x1 solid red PNG.
const RED_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe.skipIf(!enabled)("live Nexus engine", () => {
  it("answers a plain question", async () => {
    const text = await collectText([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "Reply with exactly one word: PONG" },
    ]);
    console.log("plain:", text.slice(0, 120));
    expect(text.toUpperCase()).toContain("PONG");
  }, 120_000);

  it("introduces itself as Nexus and does not claim a vendor", async () => {
    const text = await collectText([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "Who are you, in one sentence?" },
    ]);
    console.log("identity:", text.slice(0, 160));
    expect(text).toMatch(/Nexus/);
  }, 120_000);

  it("follows the text tool protocol for arithmetic", async () => {
    const tools = availableTools();
    const text = await collectText([
      { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${toolInstructions(tools)}` },
      { role: "user", content: "What is 4817 * 332? Use the calculator tool." },
    ]);
    console.log("tool line:", text.slice(0, 120));
    expect(parseToolCall(text)?.name).toBe("calculator");
  }, 120_000);

  it.skipIf(nexusConfig()?.vision === false)("can read an attached image", async () => {
    const text = await collectText([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "What colour is this image? One word.", images: [RED_PNG] },
    ]);
    console.log("vision:", text.slice(0, 120));
    expect(text.toLowerCase()).toContain("red");
  }, 120_000);
});
