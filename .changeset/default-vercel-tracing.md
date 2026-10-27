---
"@next-community/adapter-vercel": patch
---

Inject default Vercel tracing into Next.js builds that have no instrumentation file. When the build enables it, the adapter copies `@vercel/otel` from the build image into `.vercel/otel/` and points `injectInstrumentation` at a wrapper there. Any failed check skips the inject without failing the build.
