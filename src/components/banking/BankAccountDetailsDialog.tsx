import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { validateBankDetails } from "@/lib/banking/account-details";
import {
  saveBankAccountDetails,
  type BankAccountDetailsMasked,
} from "@/lib/banking/bank-ops.functions";
import { moneyFieldMinor, MoneyField } from "@/components/banking/MoneyField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Account number / sort code / IBAN / BIC and the opening statement balance.
 * Stored values are shown masked; leave a field blank to keep what is stored.
 */
export function BankAccountDetailsDialog({
  companyId,
  bankAccountId,
  accountName,
  currencyCode,
  details,
}: {
  companyId: string;
  bankAccountId: string;
  accountName: string;
  currencyCode: string;
  details: BankAccountDetailsMasked | undefined;
}) {
  const qc = useQueryClient();
  const save = useServerFn(saveBankAccountDetails);
  const [open, setOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [sortCode, setSortCode] = useState("");
  const [iban, setIban] = useState("");
  const [bic, setBic] = useState("");
  const [balance, setBalance] = useState("");
  const [balanceDate, setBalanceDate] = useState("");

  const problem = validateBankDetails({ accountNumber, sortCode, iban, bic });
  const balanceMinor = balance.trim()
    ? moneyFieldMinor(balance, currencyCode, { allowNegative: true })
    : null;
  const balanceInvalid = balance.trim() !== "" && balanceMinor === null;

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId,
          bankAccountId,
          accountNumber,
          sortCode,
          iban,
          bic,
          openingStatementBalanceMinor: balanceMinor === null ? null : Number(balanceMinor),
          openingStatementBalanceDate: balanceDate || null,
        },
      }),
    onSuccess: async () => {
      toast.success("Bank details saved");
      setOpen(false);
      setAccountNumber("");
      setSortCode("");
      setIban("");
      setBic("");
      await qc.invalidateQueries({ queryKey: ["bank-account-details", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Details
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{accountName}: bank details</DialogTitle>
          <DialogDescription>
            Stored values are masked. Type a new value to replace one; leave it blank to keep it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="bd-number">Account number</Label>
            <Input
              id="bd-number"
              value={accountNumber}
              placeholder={details?.accountNumberMasked ?? "e.g. 12345678"}
              onChange={(e) => setAccountNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bd-sort">Sort code</Label>
            <Input
              id="bd-sort"
              value={sortCode}
              placeholder={details?.sortCodeMasked ?? "12-34-56"}
              onChange={(e) => setSortCode(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bd-iban">IBAN</Label>
            <Input
              id="bd-iban"
              value={iban}
              placeholder={details?.ibanMasked ?? "GB82 WEST 1234 5698 7654 32"}
              onChange={(e) => setIban(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bd-bic">BIC / SWIFT</Label>
            <Input
              id="bd-bic"
              value={bic}
              placeholder={details?.bic ?? "NWBKGB2L"}
              onChange={(e) => setBic(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Opening statement balance ({currencyCode})</Label>
              <MoneyField
                label="Opening statement balance"
                value={balance}
                currency={currencyCode}
                options={{ allowNegative: true }}
                placeholder={
                  details?.openingStatementBalanceMinor != null
                    ? fromMinorUnits(details.openingStatementBalanceMinor, currencyCode)
                    : ""
                }
                onChange={setBalance}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bd-date">As at</Label>
              <Input
                id="bd-date"
                type="date"
                value={balanceDate}
                onChange={(e) => setBalanceDate(e.target.value)}
              />
            </div>
          </div>
          {problem ? <p className="text-sm text-destructive">{problem}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              mutation.isPending ||
              Boolean(problem) ||
              balanceInvalid ||
              (balanceMinor !== null && !balanceDate)
            }
            onClick={() => mutation.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
