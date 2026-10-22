#!/usr/bin/env bash
# LinkBooks macOS bootstrap readiness (run from repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ok() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAIL=1; }
FAIL=0

echo "LinkBooks bootstrap checks — $ROOT"
echo

command -v node >/dev/null && ok "node $(node -v)" || fail "node missing"
command -v npm >/dev/null && ok "npm $(npm -v)" || fail "npm missing"
command -v supabase >/dev/null && ok "supabase $(supabase --version 2>/dev/null | head -1)" || fail "supabase CLI missing (brew install supabase)"
command -v gh >/dev/null && ok "gh $(gh --version | head -1)" || fail "gh missing (brew install gh)"

if [[ -f .env ]] && grep -q 'VITE_SUPABASE_PUBLISHABLE_KEY=.' .env; then
  ok ".env with publishable key"
else
  fail ".env missing or publishable key empty"
fi

if [[ -d node_modules ]]; then ok "node_modules"; else fail "run: npm install"; fi

if npm run build >/dev/null 2>&1; then ok "npm run build"; else fail "npm run build failed"; fi

if supabase projects list >/dev/null 2>&1; then
  ok "supabase CLI logged in"
else
  fail "supabase login (or SUPABASE_ACCESS_TOKEN) then: supabase link --project-ref ipxflpzfcqwtenodbxwc"
fi

if [[ -f supabase/.temp/project-ref ]]; then
  ok "supabase linked ($(cat supabase/.temp/project-ref))"
else
  fail "supabase link --project-ref ipxflpzfcqwtenodbxwc"
fi

if gh auth status >/dev/null 2>&1; then
  if git push --dry-run origin HEAD >/dev/null 2>&1; then
    ok "git push to origin (rohitmehra86/LinkBooks)"
  else
    fail "gh logged in but push denied — use account rohitmehra86 (not org bot)"
  fi
else
  fail "gh auth login (GitHub account: rohitmehra86)"
fi

NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT/.npm-cache}"
export NPM_CONFIG_CACHE
if npx vercel@65.1.0 whoami >/dev/null 2>&1; then
  ok "vercel CLI logged in"
else
  fail "NPM_CONFIG_CACHE=$ROOT/.npm-cache npx vercel login (team: paxaris, project: linkbooks)"
fi

if [[ -f .vercel/project.json ]]; then ok ".vercel project link"; else fail "vercel link (paxaris / linkbooks)"; fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All checks passed."
else
  echo "Some checks failed — fix items above, then re-run this script."
  exit 1
fi
