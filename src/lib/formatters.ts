/**
 * Currency Formatters
 *
 * NOTE:
 * - Inventory Unit Cost is tracked in JAPANESE YEN (¥ / JPY).
 * - Listing Selling Price is tracked in EUROS (€ / EUR).
 */

export const formatYen = (amount: number | undefined | null): string => {
  if (amount === undefined || amount === null) return "-";
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(amount);
};

export const formatEuro = (amount: number | undefined | null): string => {
  if (amount === undefined || amount === null) return "-";
  return new Intl.NumberFormat("en-IE", {
    // IE uses €12.34 format roughly, or de-DE
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
};
