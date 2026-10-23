/** Pure rules for product / service account mapping (C-10). */

export type AccountTypeName = "asset" | "liability" | "equity" | "income" | "expense";

export type ProductAccountRole = "income" | "expense";

/**
 * Sales (income) account must be an income account. The purchase/cost account must be an
 * expense account; stock-type products (`kind = product`) may also use an asset account
 * (inventory) because costs of stock are held on the balance sheet.
 */
export function productAccountProblem(
  role: ProductAccountRole,
  accountType: string | null | undefined,
  productKind: string,
): string | null {
  if (!accountType) return `The ${role} account was not found`;
  if (role === "income") {
    return accountType === "income"
      ? null
      : "The sales account must be an income account (not a bank, liability or expense account).";
  }
  if (accountType === "expense") return null;
  if (accountType === "asset" && productKind === "product") return null;
  return productKind === "product"
    ? "The purchase account must be an expense or inventory (asset) account."
    : "The purchase account must be an expense account.";
}
