import { Input } from "@/components/ui/input";
import { tryParseMinor, type MoneyInputOptions } from "@/lib/banking/money-input";
import { cn } from "@/lib/utils";

/**
 * Text money input that accepts what people type ("12,500.00", "£1 250,5", "(40.00)").
 * It never throws: invalid text shows an inline hint and parses to `null`.
 */
export function MoneyField({
  value,
  onChange,
  currency,
  label,
  placeholder,
  className,
  options,
  disabled,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  currency: string;
  label?: string;
  placeholder?: string;
  className?: string;
  options?: MoneyInputOptions;
  disabled?: boolean;
  id?: string;
}) {
  const trimmed = value.trim();
  const invalid = trimmed !== "" && tryParseMinor(trimmed, currency, options) === null;
  return (
    <div className={cn("space-y-1", className)}>
      <Input
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder ?? "0.00"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn("font-mono", invalid && "border-destructive")}
      />
      {invalid ? <p className="text-xs text-destructive">Not a valid amount</p> : null}
    </div>
  );
}

/** Parse a MoneyField value to minor units (null when empty or invalid). */
export function moneyFieldMinor(
  value: string,
  currency: string,
  options?: MoneyInputOptions,
): bigint | null {
  if (!value.trim()) return null;
  return tryParseMinor(value, currency, options);
}
