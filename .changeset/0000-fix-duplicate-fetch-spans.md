---
"@next-community/adapter-vercel": patch
---

Prevent duplicate fetch spans by preserving the automatic fetch instrumentation opt-out when OpenTelemetry is detected during the build.
