import { z } from "zod";
import { ACCOUNT_KINDS } from "@/lib/accounting/account-kinds";

export const saveAccountSchema = z.object({
  companyId: z.string().uuid(),
  id: z.string().uuid().nullable(),
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(150),
  accountKind: z.enum(ACCOUNT_KINDS),
  description: z.string().trim().max(500),
  detailType: z.string().trim().max(80),
  parentId: z.string().uuid().nullable(),
  defaultTaxCodeId: z.string().uuid().nullable(),
  currencyCode: z.string().trim().max(3),
  isHeader: z.boolean(),
  isPaymentEnabled: z.boolean(),
  showOnDashboardWatchlist: z.boolean(),
  showInExpenseClaims: z.boolean(),
  bankName: z.string().trim().max(80),
  accountNumberMasked: z.string().trim().max(12),
});

export type SaveAccountInput = z.infer<typeof saveAccountSchema>;

export const importRowSchema = z.object({
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(150),
  accountKind: z.enum(ACCOUNT_KINDS),
  description: z.string().trim().max(500).default(""),
  parentCode: z.string().trim().max(10).default(""),
  detailType: z.string().trim().max(80).default(""),
  isHeader: z.boolean().default(false),
  currencyCode: z
    .string()
    .trim()
    .max(3)
    .default("")
    .refine(
      (value) => value === "" || /^[A-Za-z]{3}$/.test(value),
      "Currency must be a 3-letter code.",
    ),
});

export const importAccountsSchema = z.object({
  companyId: z.string().uuid(),
  commit: z.boolean(),
  rows: z.array(importRowSchema).min(1).max(500),
});
