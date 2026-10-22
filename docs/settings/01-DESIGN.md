# Settings Centre — design tokens & IA

## Direction
Follow the existing LinkBooks app shell: restrained colour, clear hierarchy, spacious panels, Radix/shadcn primitives. No decorative controls.

## Tokens (reuse app CSS variables)
- Surface: `bg-background`, `bg-card`, `border-border`
- Text: `text-foreground`, `text-muted-foreground`
- Accent: existing primary (not a new purple theme)
- Motion: respect `prefers-reduced-motion`; collapsible nav only
- Focus: visible ring on nav items, switches, and command palette

## Information architecture
Persistent left category nav (collapsible groups, remembered in `localStorage`). Deep links via `?section=`.

Groups: Start · Organisation · Operations · Platform · Firm & plan.

## Patterns
- Overview: status, warnings, integration honesty, quick links
- Feature Manager: five-state badges + switches
- Category panels: short description, module deep links, typed fields, Save
- Unavailable: explicit alert — never “connected”
- Command palette: Ctrl/Cmd+K — settings + modules
- Search synonyms: VAT→Tax, closing date→Accounting, etc.

## Accessibility
WCAG 2.2 AA targets: keyboard nav, aria-labels on filter/search, visible focus, no information by colour alone (badges include text).
