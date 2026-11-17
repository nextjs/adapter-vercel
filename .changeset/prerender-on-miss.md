---
"@next-community/adapter-vercel": patch
---

Emit `onMiss` on prerender configs, derived per output from its Next.js
response classification: `sync` when the response is `complete`, `dynamic`
when it is `initial` or `empty`, omitted when the output is unclassified
(older Next.js, `fallback: false` templates, unclassified group siblings) or
a Route Handler.

**Behavior change once the platform honors `onMiss`:** cache misses on routes
that emit `dynamic` are served with a per-request dynamic render while the
cached shell is refreshed in the background, instead of blocking the request
on a synchronous revalidation. Routes that emit `sync` (or omit the field)
keep the current blocking-miss behavior; until the platform supports the
field it is inert.
