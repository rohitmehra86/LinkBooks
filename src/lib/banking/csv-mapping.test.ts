import { describe, expect, it } from "vitest";
import {
  applyMapping,
  assignExternalIds,
  coerceMapping,
  contentKey,
  DEFAULT_MAPPING,
  detectDelimiter,
  findLikelyDuplicates,
  guessDateFormat,
  guessMapping,
  parseCsvText,
  parseDateValue,
  sha256Hex,
  validateMapping,
  type ImportMapping,
} from "./csv-mapping";

const base = (over: Partial<ImportMapping> = {}): ImportMapping => ({
  ...DEFAULT_MAPPING,
  ...over,
});

describe("parseCsvText", () => {
  it("handles quotes, embedded commas/newlines, escaped quotes and CRLF", () => {
    const { rows } = parseCsvText(
      'Date,Desc,Amt\r\n01/02/2026,"Smith, J ""Ltd""",10.00\r\n02/02/2026,"two\nlines",-5\r\n',
    );
    expect(rows).toEqual([
      ["Date", "Desc", "Amt"],
      ["01/02/2026", 'Smith, J "Ltd"', "10.00"],
      ["02/02/2026", "two\nlines", "-5"],
    ]);
  });
  it("auto-detects semicolon and tab delimiters, ignoring blank lines and BOM", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"a,b";c;d')).toBe(";");
    const { rows, delimiter } = parseCsvText("\uFEFFd;a\n\n1;2,50\n");
    expect(delimiter).toBe(";");
    expect(rows).toEqual([
      ["d", "a"],
      ["1", "2,50"],
    ]);
  });
});

describe("parseDateValue — real calendar validation (BK-07)", () => {
  it("parses all supported formats", () => {
    expect(parseDateValue("31/12/2026", "DD/MM/YYYY")).toBe("2026-12-31");
    expect(parseDateValue("12/31/2026", "MM/DD/YYYY")).toBe("2026-12-31");
    expect(parseDateValue("2026-02-05", "YYYY-MM-DD")).toBe("2026-02-05");
    expect(parseDateValue("5-Feb-2026", "DD-MMM-YYYY")).toBe("2026-02-05");
    expect(parseDateValue("05 September 2026", "DD-MMM-YYYY")).toBe("2026-09-05");
    expect(parseDateValue("01/03/26", "DD/MM/YY")).toBe("2026-03-01");
    expect(parseDateValue("03/01/26", "MM/DD/YY")).toBe("2026-03-01");
    expect(parseDateValue("2026-02-05T10:30:00Z", "YYYY-MM-DD")).toBe("2026-02-05");
  });
  it("swaps day and month correctly for US vs UK", () => {
    expect(parseDateValue("03/04/2026", "DD/MM/YYYY")).toBe("2026-04-03");
    expect(parseDateValue("03/04/2026", "MM/DD/YYYY")).toBe("2026-03-04");
  });
  it("rejects impossible dates", () => {
    expect(parseDateValue("31/02/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDateValue("13/13/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDateValue("29/02/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDateValue("29/02/2028", "DD/MM/YYYY")).toBe("2028-02-29");
    expect(parseDateValue("31-Apr-2026", "DD-MMM-YYYY")).toBeNull();
    expect(parseDateValue("30-Foo-2026", "DD-MMM-YYYY")).toBeNull();
    expect(parseDateValue("", "YYYY-MM-DD")).toBeNull();
    expect(parseDateValue("2026-00-10", "YYYY-MM-DD")).toBeNull();
  });
  it("guesses the format from samples", () => {
    expect(guessDateFormat(["2026-01-05"])).toBe("YYYY-MM-DD");
    expect(guessDateFormat(["13/01/2026", "05/02/2026"])).toBe("DD/MM/YYYY");
    expect(guessDateFormat(["01/13/2026", "02/05/2026"])).toBe("MM/DD/YYYY");
    expect(guessDateFormat(["5 Feb 2026"])).toBe("DD-MMM-YYYY");
    expect(guessDateFormat(["13/01/26"])).toBe("DD/MM/YY");
  });
});

describe("applyMapping — amounts", () => {
  it("US file: MM/DD/YYYY with thousands separators and parentheses negatives", () => {
    const { rows } = parseCsvText(
      'Date,Description,Amount\n03/04/2026,Rent,"(1,250.00)"\n12/13/2026,Client pay,"2,500.50"\n',
    );
    const mapping = base({ dateFormat: "MM/DD/YYYY" });
    const r = applyMapping(rows, mapping, "USD");
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.txnDate, x.amountMinor])).toEqual([
      ["2026-03-04", -125000n],
      ["2026-12-13", 250050n],
    ]);
  });

  it("European file: semicolons, decimal comma and dots as thousands (1.234,56 → 123456)", () => {
    const { rows } = parseCsvText(
      "Datum;Text;Betrag\n05.02.2026;Miete;-1.234,56\n06.02.2026;Gehalt;2.000,00\n",
    );
    const mapping = base({ decimalSeparator: ",", dateFormat: "DD/MM/YYYY" });
    const r = applyMapping(rows, mapping, "EUR");
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.amountMinor)).toEqual([-123456n, 200000n]);
    expect(r.rows[0]!.txnDate).toBe("2026-02-05");
  });

  it("UK Debit / Credit columns", () => {
    const { rows } = parseCsvText(
      "Date,Description,Paid out,Paid in,Balance\n01/03/2026,Tesco,12.50,,987.50\n02/03/2026,Customer,,1000.00,1987.50\n03/03/2026,Bad,1.00,1.00,0\n04/03/2026,Blank,,,0\n",
    );
    const mapping = base({
      amountMode: "debit_credit",
      amountColumn: null,
      debitColumn: 2,
      creditColumn: 3,
      balanceColumn: 4,
    });
    const r = applyMapping(rows, mapping, "GBP");
    expect(r.rows.map((x) => x.amountMinor)).toEqual([-1250n, 100000n]);
    expect(r.rows[0]!.balanceMinor).toBe(98750n);
    expect(r.errors.map((e) => e.rowNumber)).toEqual([4, 5]);
  });

  it("trailing minus and CR/DR suffixes", () => {
    const { rows } = parseCsvText("d,x,a\n01/03/2026,A,12.50-\n01/03/2026,B,7.00\n");
    expect(applyMapping(rows, base(), "GBP").rows.map((x) => x.amountMinor)).toEqual([
      -1250n,
      700n,
    ]);

    const crdr = parseCsvText("d,x,a\n01/03/2026,A,12.50 DR\n01/03/2026,B,7.00 CR\n").rows;
    const r = applyMapping(crdr, base({ amountMode: "suffix" }), "GBP");
    expect(r.rows.map((x) => x.amountMinor)).toEqual([-1250n, 700n]);
  });

  it("uses the bank account currency decimals (JPY 0, KWD 3), not ×100", () => {
    const { rows } = parseCsvText('d,x,a\n01/03/2026,A,"1,500"\n');
    expect(applyMapping(rows, base(), "JPY").rows[0]!.amountMinor).toBe(1500n);
    const k = parseCsvText("d,x,a\n01/03/2026,A,1.250\n").rows;
    expect(applyMapping(k, base(), "KWD").rows[0]!.amountMinor).toBe(1250n);
    // trailing zero beyond 2 decimals is harmless for GBP
    expect(applyMapping(k, base(), "GBP").rows[0]!.amountMinor).toBe(125n);
  });

  it("rejects amounts with digits the currency cannot hold", () => {
    const { rows } = parseCsvText("d,x,a\n01/03/2026,A,1.505\n");
    const r = applyMapping(rows, base(), "GBP");
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0]!.message).toMatch(/Invalid amount/);
  });

  it("flips the sign when invertSign is set and reports zero amounts", () => {
    const { rows } = parseCsvText("d,x,a\n01/03/2026,A,5.00\n01/03/2026,B,0.00\n");
    const r = applyMapping(rows, base({ invertSign: true }), "GBP");
    expect(r.rows[0]!.amountMinor).toBe(-500n);
    expect(r.errors[0]!.message).toMatch(/zero/i);
  });

  it("captures reference, payee, multi-column description and bank id", () => {
    const { rows } = parseCsvText(
      "Date,Desc,Memo,Ref,Payee,Id,Amt\n2026-03-01,Card,Coffee,R1,Cafe,TX9,-3.50\n",
    );
    const r = applyMapping(
      rows,
      base({
        dateFormat: "YYYY-MM-DD",
        descriptionColumns: [1, 2],
        referenceColumn: 3,
        payeeColumn: 4,
        bankIdColumn: 5,
        amountColumn: 6,
      }),
      "GBP",
    );
    expect(r.rows[0]).toMatchObject({
      description: "Card Coffee",
      reference: "R1",
      payee: "Cafe",
      bankId: "TX9",
      amountMinor: -350n,
    });
  });

  it("reports bad dates with the row number", () => {
    const { rows } = parseCsvText("d,x,a\n31/02/2026,A,1.00\n01/03/2026,B,2.00\n");
    const r = applyMapping(rows, base(), "GBP");
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual([{ rowNumber: 2, message: expect.stringContaining("Invalid date") }]);
  });
});

describe("guessMapping + validateMapping + coerceMapping", () => {
  it("guesses debit/credit headers and comma decimals", () => {
    const { rows } = parseCsvText(
      "Booking date;Narrative;Debit;Credit;Balance\n13.01.2026;Shop;12,50;;100,00\n",
    );
    const m = guessMapping(rows, ";");
    expect(m.amountMode).toBe("debit_credit");
    expect(m.debitColumn).toBe(2);
    expect(m.creditColumn).toBe(3);
    expect(m.balanceColumn).toBe(4);
    expect(m.decimalSeparator).toBe(",");
    expect(m.dateFormat).toBe("DD/MM/YYYY");
    expect(m.descriptionColumns).toEqual([1]);
  });
  it("validates column ranges", () => {
    expect(validateMapping(base(), 3)).toEqual([]);
    expect(validateMapping(base({ amountColumn: 9 }), 3).join()).toMatch(/out of range/);
    expect(validateMapping(base({ descriptionColumns: [] }), 3).join()).toMatch(/description/i);
  });
  it("coerces saved JSON safely", () => {
    expect(coerceMapping(null)).toBeNull();
    expect(coerceMapping({ dateColumn: 0 })).toBeNull();
    const m = coerceMapping({
      ...DEFAULT_MAPPING,
      dateFormat: "nonsense",
      decimalSeparator: ",",
      amountColumn: -1,
    });
    expect(m?.dateFormat).toBe("DD/MM/YYYY");
    expect(m?.decimalSeparator).toBe(",");
    expect(m?.amountColumn).toBeNull();
  });
});

describe("duplicate hashing (BK-08)", () => {
  const acct = "11111111-1111-1111-1111-111111111111";
  const row = (
    n: number,
    d = "Coffee",
    amt = -350n,
    date = "2026-03-01",
    bankId: string | null = null,
  ) => ({
    rowNumber: n,
    txnDate: date,
    amountMinor: amt,
    description: d,
    reference: null,
    payee: null,
    bankId,
    balanceMinor: null,
  });

  it("is SHA-256 (64 hex chars)", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const [k] = await assignExternalIds([row(2)], acct);
    expect(k!.externalId).toMatch(/^csv2_[0-9a-f]{64}$/);
  });

  it("two identical coffees on one day get different ids", async () => {
    const keyed = await assignExternalIds([row(2), row(3), row(4, "Tea")], acct);
    expect(new Set(keyed.map((k) => k.externalId)).size).toBe(3);
    expect(keyed.map((k) => k.ordinal)).toEqual([0, 1, 0]);
    expect(keyed[0]!.groupKey).toBe(keyed[1]!.groupKey);
  });

  it("same file twice → same ids; different account → different ids; salt changes ids", async () => {
    const a = await assignExternalIds([row(2), row(3)], acct);
    const b = await assignExternalIds([row(2), row(3)], acct);
    expect(a.map((x) => x.externalId)).toEqual(b.map((x) => x.externalId));
    const other = await assignExternalIds([row(2)], "22222222-2222-2222-2222-222222222222");
    expect(other[0]!.externalId).not.toBe(a[0]!.externalId);
    const salted = await assignExternalIds([row(2)], acct, "force:imp1");
    expect(salted[0]!.externalId).not.toBe(a[0]!.externalId);
  });

  it("whitespace/case differences in the description do not change the id", async () => {
    const a = await assignExternalIds([row(2, "Costa  Coffee")], acct);
    const b = await assignExternalIds([row(9, "costa coffee")], acct);
    expect(a[0]!.externalId).toBe(b[0]!.externalId);
  });

  it("a bank transaction id takes priority over content", async () => {
    const a = await assignExternalIds([row(2, "x", -1n, "2026-01-01", "TX1")], acct);
    const b = await assignExternalIds([row(2, "different", -999n, "2026-02-02", "TX1")], acct);
    expect(a[0]!.externalId).toBe(b[0]!.externalId);
  });

  it("flags likely duplicates with multiplicity instead of dropping silently", async () => {
    const keyed = await assignExternalIds([row(2), row(3), row(4)], acct);
    // 1) database already has the first coffee imported under the OLD hash → only the first row flagged
    const flags = findLikelyDuplicates(keyed, {
      externalIds: new Set(),
      contentCounts: new Map([[contentKey("2026-03-01", -350n, "Coffee"), 1]]),
    });
    expect(flags).toEqual([{ rowNumber: 2, reason: "same_content_already_imported" }]);
    // 2) exact id match
    const exact = findLikelyDuplicates(keyed, {
      externalIds: new Set([keyed[1]!.externalId]),
      contentCounts: new Map(),
    });
    expect(exact).toEqual([{ rowNumber: 3, reason: "same_external_id" }]);
    // 3) nothing imported yet
    expect(
      findLikelyDuplicates(keyed, { externalIds: new Set(), contentCounts: new Map() }),
    ).toEqual([]);
  });
});
