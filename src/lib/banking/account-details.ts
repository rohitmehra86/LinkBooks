/** Pure validation / masking helpers for bank account identifiers (mirrors the database checks). */

export function normaliseSortCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
}

export function normaliseAccountNumber(input: string): string | null {
  const s = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-Z]{4,34}$/.test(s) ? s : null;
}

/** ISO 13616 mod-97 check. Accepts spaces and lower case. */
export function isValidIban(input: string): boolean {
  const s = input.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidBic(input: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(input.replace(/\s/g, "").toUpperCase());
}

/** Show only the last `keep` characters (e.g. "••••5678"). Never returns the full value. */
export function maskIdentifier(value: string | null | undefined, keep = 4): string {
  if (!value) return "";
  if (value.length <= keep) return "•".repeat(value.length);
  return "•".repeat(value.length - keep) + value.slice(-keep);
}

export type BankDetailsInput = {
  accountNumber?: string;
  sortCode?: string;
  iban?: string;
  bic?: string;
};

/** First problem with the entered values, or null when everything entered is valid (blank = unchanged). */
export function validateBankDetails(input: BankDetailsInput): string | null {
  if (input.sortCode?.trim() && !normaliseSortCode(input.sortCode)) {
    return "Sort code must be 6 digits (e.g. 12-34-56)";
  }
  if (input.accountNumber?.trim() && !normaliseAccountNumber(input.accountNumber)) {
    return "Account number must be 4 to 34 letters or digits";
  }
  if (input.iban?.trim() && !isValidIban(input.iban)) {
    return "That IBAN is not valid (check the digits)";
  }
  if (input.bic?.trim() && !isValidBic(input.bic)) return "BIC must be 8 or 11 characters";
  return null;
}
