# Module integration map (setting → consumer)

| Setting / feature | Consumer | Status |
|-------------------|----------|--------|
| Classes / Locations / Projects features | New Bill professional view | **Wired** — `listOrganisationFeatures` gates visibility |
| Billable expenses feature | New Bill billable column | **Wired** |
| Lock dates / conversion | `post_journal` | **Wired** — DB enforcement |
| Period status locks | `/accounting` + `post_journal` | Existing |
| Workflow sales/purchases defaults | Module settings pages | Existing |
| Document sequences | Invoice/bill allocate | Existing |
| Dimensions CRUD | Settings → Dimensions | Existing |
| Accounting config (warnings, basis) | Settings → Accounting | Stored; UI warnings partial |
| Sales late fees / reminders config | Settings → Sales | Stored; posting of late fees **Unavailable** until job exists |
| Multicurrency feature disable | Dependency engine | Blocks when FX currencies present (evaluate) |
| AI feature | Feature Manager + AI page | Honest not configured |
| Portals / Fixed assets / Subscription | Settings panels | **Unavailable** |

## Preserve
New Bill workspace behaviour and sidebar prefs remain authoritative for bill UX.
