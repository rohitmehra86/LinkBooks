/** Minimal RFC 4180 CSV writer with spreadsheet-formula neutralisation. Pure. */

function neutraliseFormula(s: string): string {
  // Excel/Sheets treat a leading = + - @ (or tab/CR) as a formula. Prefix with an apostrophe.
  return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = neutraliseFormula(String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Minor units -> plain decimal string (no currency symbol), using the currency's decimals. */
export function minorToDecimalString(minor: number, decimals = 2): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const base = 10 ** decimals;
  const whole = Math.floor(abs / base);
  const frac = String(abs % base).padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole}${decimals ? `.${frac}` : ""}`;
}
