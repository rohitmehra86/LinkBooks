# Vercel deploy (public URL for friend testing)

## Production URL
https://linkbooks-navy.vercel.app

## Redeploy
```bash
cd /Users/rohitm/paxaris-repos/LinkBooks
vercel --prod
```

## Supabase Auth URLs (required for signup/login on Vercel)
Dashboard → Authentication → URL Configuration:
- Site URL: `https://linkbooks-navy.vercel.app`
- Redirect URLs include:
  - `https://linkbooks-navy.vercel.app/**`
  - `http://127.0.0.1:5173/**`
  - `http://localhost:5173/**`
