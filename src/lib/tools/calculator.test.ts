import { describe, expect, it } from "vitest";
import { calculatorTool } from "./calculator";

describe("calculator tool", () => {
  it("evaluates basic arithmetic", async () => {
    const result = await calculatorTool.run("2 + 3 * 4");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 14 });
  });

  it("handles unary minus", async () => {
    const result = await calculatorTool.run("-5 + 2");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: -3 });
  });

  it("handles constants and functions", async () => {
    const result = await calculatorTool.run("sqrt(9) + abs(-2)");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 5 });
  });

  it("rejects unsupported characters", async () => {
    const result = await calculatorTool.run("2 + foo");
    expect(result.ok).toBe(false);
  });

  it("rejects non-finite results", async () => {
    const result = await calculatorTool.run("1 / 0");
    expect(result.ok).toBe(false);
  });

  it("uses right-associative exponentiation", async () => {
    const result = await calculatorTool.run("2^3^2");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 512 });
  });

  it("supports multi-argument min", async () => {
    const result = await calculatorTool.run("min(9, 2, 5)");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 2 });
  });

  it("supports multi-argument max", async () => {
    const result = await calculatorTool.run("max(9, 2, 5)");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 9 });
  });
});
