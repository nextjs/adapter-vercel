---
"@next-community/adapter-vercel": patch
---

Emit `onMiss` on prerender configs, derived per prerender group from the
Next.js response classification: `sync` when the canonical response is
`complete`, `dynamic` when it is `initial` or `empty`, omitted when the group
is unclassified (older Next.js, `fallback: false` templates) or a Route
Handler.

**Behavior change once the platform proxy flag is enabled:** upgrading the
adapter changes cache-miss behavior for every PPR route with dynamic holes.
Misses on those routes are served dynamically per request while a single
coalesced async revalidation backfills the shell, instead of blocking on a
synchronous revalidation. This is intended and cost-neutral — a blocking miss
on a dynamic-hole route already costs two invocations — but the change in
serving behavior is visible. Routes whose stored shell is a complete response
emit `onMiss: "sync"` and keep today's collapsed single-invocation miss
handling. The field is inert until the platform proxy flag is enabled;
until then all routes keep the current blocking-miss behavior.
