---
"@next-community/adapter-vercel": patch
---

Pass through prerender classification metadata (`hasPostponed`, `hasFallback`, `htmlSize`, `isDynamicRoute`) from `AdapterOutput['PRERENDER']` to `prerender-config.json`, matching the `@vercel/next` builder so deployment summaries can classify PPR and Cache Components routes. The fields are tri-state: `false`/`0` are written as-is and only `undefined` is omitted.
