/**
 * Accessibility attributes for a form control, wired to FormField's helper/error text ids.
 * `<Input {...fieldA11y("email", { error })} />` gives it an id, aria-invalid and
 * aria-describedby pointing at the visible helper/error message.
 */
export function fieldA11y(
  id: string,
  opts: { error?: string | null | undefined; helper?: boolean; required?: boolean } = {},
): {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  "aria-required"?: true;
} {
  const described: string[] = [];
  if (opts.error) described.push(`${id}-error`);
  if (opts.helper) described.push(`${id}-help`);
  return {
    id,
    ...(opts.error ? { "aria-invalid": true as const } : {}),
    ...(described.length ? { "aria-describedby": described.join(" ") } : {}),
    ...(opts.required ? { "aria-required": true as const } : {}),
  };
}
