/**
 * Currency formatting for a Stripe `unit_amount`, plus a read-only lookup of
 * the single configured subscription price.
 *
 * These live apart from the checkout route so the pricing page can display the
 * real price without touching any billing flow.
 */

/** Currencies Stripe reports without minor units. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
]);

/*
 * Stripe's documented special cases: ISK and UGX are whole-unit money, but
 * backward compatibility keeps the API amount two-decimal, so `500` buys 5 of
 * them and no fraction is ever chargeable. Divide by the minor unit the way the
 * API asks and print the whole number the way the currency works.
 */
const WHOLE_UNIT_CURRENCIES = new Set(["ISK", "UGX"]);

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CAD: "C$",
  AUD: "A$",
  INR: "₹",
  PKR: "Rs ",
};

export function formatMoney(unitAmount: number, currency: string): string {
  const code = currency.toUpperCase();
  const minorUnits = ZERO_DECIMAL_CURRENCIES.has(code)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(code)
      ? 3
      : 2;
  const amount = unitAmount / 10 ** minorUnits;
  const decimals = WHOLE_UNIT_CURRENCIES.has(code) ? 0 : minorUnits;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const symbol = CURRENCY_SYMBOLS[code];

  return symbol
    ? `${symbol}${formatted}`
    : `${formatted} ${code}`;
}

const INTERVAL_LABELS: Record<string, string> = {
  day: "/day",
  week: "/week",
  month: "/month",
  year: "/year",
};

export function formatInterval(interval: string | null | undefined): string {
  if (!interval) return "one-time";
  return INTERVAL_LABELS[interval] ?? `/${interval}`;
}
