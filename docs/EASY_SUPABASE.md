# Easy Supabase workflow (LinkBooks + Cursor)

## One-time setup (this Mac)

### A. Cursor plugin
- Supabase plugin is installed in Cursor (marketplace).

### B. Supabase CLI
```bash
supabase --version
```
Already installed via Homebrew if setup was run.

### C. Login + link this project
```bash
cd /Users/rohitm/paxaris-repos/LinkBooks
supabase login          # opens browser — create/paste access token
supabase link --project-ref ipxflpzfcqwtenodbxwc
```

Your cloud project (rohitmehra86):  
https://supabase.com/dashboard/project/ipxflpzfcqwtenodbxwc

### D. Cursor MCP (talk to Supabase from chat)
Project file: `.cursor/mcp.json` (scoped to `ipxflpzfcqwtenodbxwc`).

1. Cursor → **Settings → Tools & MCP**
2. Find **supabase** → enable / connect
3. Browser opens → **log in as rohitmehra86** and allow access
4. Come back to Cursor — ask: `What tables are in my Supabase database?`

No personal access token needed for normal use (OAuth login).

### E. App env
1. Open **Project Settings → API**:  
   https://supabase.com/dashboard/project/ipxflpzfcqwtenodbxwc/settings/api
2. Copy **Project URL** + **anon / publishable** key into local `.env` (see `.env.example`)
3. Keys stay local — never commit `.env`

### F. Load LinkBooks schema into the new empty project
```bash
cd /Users/rohitm/paxaris-repos/LinkBooks
supabase link --project-ref ipxflpzfcqwtenodbxwc
supabase db push
```
This applies files under `supabase/migrations/` to your new project.

---

## Daily easy steps

| Goal | Do this |
|------|---------|
| Run the app | `npm run dev` → http://127.0.0.1:5173 |
| See users | Dashboard → Authentication → Users |
| See data | Dashboard → Table Editor |
| Run SQL | Dashboard → SQL Editor **or** ask Cursor (MCP) |
| Change schema | Add SQL under `supabase/migrations/` then `supabase db push` |
| Ask agent | “List tables” / “Show RLS on companies” (needs MCP token) |

## Commands cheat sheet

```bash
cd /Users/rohitm/paxaris-repos/LinkBooks

npm run dev                 # UI
supabase projects list      # your cloud projects
supabase db push            # apply local migrations to linked project
supabase db pull            # pull remote schema into migrations (careful)
```

## Don’t

- Don’t commit `.env` or **service role** keys  
- Don’t push DB changes to friend’s upstream until reviewed  
- Push code to **origin** = `rohitmehra86/LinkBooks`
