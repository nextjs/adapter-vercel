---
"@next-community/adapter-vercel": patch
---

Skip `use cache` function references (`$$RSC_SERVER_CACHE_*`) when emitting server-action meta routes. Cached functions are only invoked by the server during rendering, never via a `next-action` header, so their routes could never match and only consumed CDN route slots.
