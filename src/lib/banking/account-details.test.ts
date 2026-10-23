import { describe, expect, it } from "vitest";
import {
  isValidBic,
  isValidIban,
  maskIdentifier,
  normaliseAccountNumber,
  normaliseSortCode,
  validateBankDetails,
} from "./account-details";

describe("bank account identifiers", () => {
  it("validates IBANs with the mod-97 check", () => {
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("de89370400440532013000")).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(isValidIban("GB82")).toBe(false);
  });
  it("normalises sort codes", () => {
    expect(normaliseSortCode("123456")).toBe("12-34-56");
    expect(normaliseSortCode("12 34 56")).toBe("12-34-56");
    expect(normaliseSortCode("12-34")).toBeNull();
  });
  it("normalises account numbers and BICs", () => {
    expect(normaliseAccountNumber("1234-5678")).toBe("12345678");
    expect(normaliseAccountNumber("12")).toBeNull();
    expect(isValidBic("nwbkgb2l")).toBe(true);
    expect(isValidBic("NWBK")).toBe(false);
  });
  it("masks everything except the last four characters", () => {
    expect(maskIdentifier("12345678")).toBe("••••5678");
    expect(maskIdentifier("123")).toBe("•••");
    expect(maskIdentifier(null)).toBe("");
  });
  it("reports the first invalid entered field and ignores blanks", () => {
    expect(validateBankDetails({})).toBeNull();
    expect(validateBankDetails({ sortCode: "1234" })).toMatch(/Sort code/);
    expect(validateBankDetails({ iban: "GB00" })).toMatch(/IBAN/);
    expect(validateBankDetails({ accountNumber: "12345678", sortCode: "12-34-56" })).toBeNull();
  });
});
