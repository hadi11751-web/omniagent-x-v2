import { describe, expect, it } from "vitest";
import { calculatorTool } from "./calculator";

async function evaluate(expression: string): Promise<unknown> {
  const result = await calculatorTool.run(expression);
  if (!result.ok) throw new Error(result.content);
  return Number(result.content.split(" = ").at(-1));
}

describe("calculator", () => {
  it("evaluates arithmetic with precedence and parentheses", async () => {
    expect(await evaluate("2 + 3 * 4")).toBe(14);
    expect(await evaluate("(2 + 3) * 4")).toBe(20);
    expect(await evaluate("10 % 3")).toBe(1);
    expect(await evaluate("-5 + 3")).toBe(-2);
  });

  it("treats exponentiation as right-associative", async () => {
    expect(await evaluate("2^3^2")).toBe(512);
    expect(await evaluate("2^-3")).toBe(0.125);
    expect(await evaluate("-2^2")).toBe(-4);
  });

  it("supports single argument functions", async () => {
    expect(await evaluate("sqrt(16)")).toBe(4);
    expect(await evaluate("abs(-4)")).toBe(4);
    expect(await evaluate("floor(3.7)")).toBe(3);
    expect(await evaluate("ceil(3.2)")).toBe(4);
  });

  it("supports multi argument functions", async () => {
    expect(await evaluate("min(1, 2)")).toBe(1);
    expect(await evaluate("max(3, 7, 2)")).toBe(7);
    expect(await evaluate("max(min(1, 2), 3)")).toBe(3);
    expect(await evaluate("min(-1, 5)")).toBe(-1);
  });

  it("reports errors instead of throwing", async () => {
    expect((await calculatorTool.run("(1 + 2")).ok).toBe(false);
    expect((await calculatorTool.run("1 +")).ok).toBe(false);
    expect((await calculatorTool.run("1 / 0")).ok).toBe(false);
    expect((await calculatorTool.run("drop table users")).ok).toBe(false);
  });
});
