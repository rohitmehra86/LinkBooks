import type { ComponentType } from "react";
import { useActiveCompany } from "@/hooks/use-active-company";

export async function loadCreatePanel(id: string): Promise<ComponentType> {
  switch (id) {
    case "invoice": {
      const m = await import("@/routes/_authenticated/sales/invoices.new");
      return m.NewInvoice;
    }
    case "quote": {
      const m = await import("@/routes/_authenticated/sales/quotes.new");
      return m.NewQuote;
    }
    case "receive_payment": {
      const m = await import("@/routes/_authenticated/sales/receipts.new");
      return m.NewReceipt;
    }
    case "customer_credit": {
      const m = await import("@/routes/_authenticated/sales/credit-notes.new");
      return m.NewCredit;
    }
    case "recurring_invoice": {
      const m = await import("@/routes/_authenticated/sales/recurring");
      return m.RecurringInvoices;
    }
    case "customer_statement": {
      const m = await import("@/routes/_authenticated/sales/statements");
      return m.Statements;
    }
    case "bill": {
      const m = await import("@/routes/_authenticated/purchases/bills.new");
      return m.NewBill;
    }
    case "recurring_bill": {
      const m = await import("@/routes/_authenticated/purchases/bills.new");
      return function RecurringBillPanel() {
        return <m.NewBill mode="template" />;
      };
    }
    case "purchase_order": {
      const m = await import("@/routes/_authenticated/purchases/orders.new");
      return m.NewOrder;
    }
    case "pay_bill": {
      const m = await import("@/routes/_authenticated/purchases/payments.new");
      return m.NewPayment;
    }
    case "expense": {
      const m = await import("@/routes/_authenticated/purchases/expenses.new");
      return m.NewExpense;
    }
    case "supplier_credit": {
      const m = await import("@/routes/_authenticated/purchases/credit-notes.new");
      return m.NewCreditNote;
    }
    case "reimbursement": {
      const m = await import("@/routes/_authenticated/purchases/employee-expenses");
      return m.EmployeeExpensesPage;
    }
    case "bank_transfer": {
      const m = await import("@/routes/_authenticated/banking/transfers");
      return m.Transfers;
    }
    case "sales_receipt":
    case "customer_refund":
    case "supplier_refund":
    case "receive_money":
    case "bank_deposit":
    case "card_payment":
    case "bank_adjustment": {
      const m = await import("@/components/create-new/MoneyDocumentPanel");
      const kind = id as
        | "sales_receipt"
        | "customer_refund"
        | "supplier_refund"
        | "receive_money"
        | "bank_deposit"
        | "card_payment"
        | "bank_adjustment";
      return function MoneyPanel() {
        return <m.MoneyDocumentPanel kind={kind} />;
      };
    }
    case "manual_journal": {
      const m = await import("@/components/create-new/JournalPanels");
      return m.ManualJournalPanel;
    }
    case "recurring_journal": {
      const m = await import("@/components/create-new/JournalPanels");
      return m.RecurringJournalPanel;
    }
    case "project": {
      const m = await import("@/components/create-new/ProjectPanel");
      return m.ProjectPanel;
    }
    case "document_upload": {
      const m = await import("@/components/create-new/InboxPanel");
      return m.InboxPanel;
    }
    case "customer": {
      const m = await import("@/routes/_authenticated/contacts/index");
      return function CustomerPanel() {
        return <m.ContactsPage initialKind="customer" />;
      };
    }
    case "supplier": {
      const m = await import("@/routes/_authenticated/contacts/index");
      return function SupplierPanel() {
        return <m.ContactsPage initialKind="supplier" />;
      };
    }
    case "product": {
      const m = await import("@/routes/_authenticated/products-services");
      return m.ProductsPage;
    }
    case "account": {
      const m = await import("@/components/accounting/IndustryCoaPanel");
      return function AccountPanel() {
        const { company } = useActiveCompany();
        if (!company) return null;
        return <m.IndustryCoaPanel companyId={company.id} />;
      };
    }
    default:
      throw new Error("This action has no form");
  }
}
