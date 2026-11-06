---
"@next-community/adapter-vercel": patch
---

Inject default Vercel tracing into Next.js builds that have no instrumentation file. When the build enables it, the adapter points `instrumentationInject` at the wrapper the Vercel builder prepares in `.vercel/otel/` before `next build`. Any failed check skips the inject without failing the build.
