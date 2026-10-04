import { describe, expect, it } from "vitest";
import { formatInterval, formatMoney } from "@/lib/money";

describe("formatMoney", () => {
  it("uses two decimals and a symbol for a decimal currency", () => {
    expect(formatMoney(1900, "usd")).toBe("$19.00");
    expect(formatMoney(999, "EUR")).toBe("€9.99");
  });

  it("formats Stripe three-decimal currencies", () => {
    // Stripe rounds a three-decimal amount to the nearest ten minor units, so
    // 5120 is 5.120 KWD and 1000 is 1.000 BHD.
    expect(formatMoney(5120, "KWD")).toBe("5.120 KWD");
    expect(formatMoney(1000, "BHD")).toBe("1.000 BHD");
  });

  it("uses no decimals for a zero-decimal currency", () => {
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
    expect(formatMoney(900, "KRW")).toBe("900 KRW");
  });

  it("divides ISK and UGX as the API asks but prints whole units", () => {
    // Stripe keeps these two-decimal in the amount field (`500` buys 5) while
    // forbidding fractions, so neither `500 ISK` nor `5.00 ISK` is the price.
    expect(formatMoney(500, "ISK")).toBe("5 ISK");
    expect(formatMoney(1200, "UGX")).toBe("12 UGX");
  });

  it("groups thousands", () => {
    expect(formatMoney(125000, "USD")).toBe("$1,250.00");
  });

  it("falls back to the currency code when there is no symbol", () => {
    expect(formatMoney(4500, "chf")).toBe("45.00 CHF");
  });

  it("keeps sub-unit amounts visible", () => {
    expect(formatMoney(1, "USD")).toBe("$0.01");
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });
});

describe("formatInterval", () => {
  it("labels the recurring intervals", () => {
    expect(formatInterval("month")).toBe("/month");
    expect(formatInterval("year")).toBe("/year");
    expect(formatInterval("week")).toBe("/week");
    expect(formatInterval("day")).toBe("/day");
  });

  it("says one-time when there is no interval", () => {
    expect(formatInterval(null)).toBe("one-time");
    expect(formatInterval(undefined)).toBe("one-time");
  });

  it("passes an unknown interval through instead of hiding it", () => {
    expect(formatInterval("every-two-weeks")).toBe("/every-two-weeks");
  });
});
