---
'@next-community/adapter-vercel': patch
---

Replace the JavaScript adapter output generator with Go behind the existing adapter entrypoint. Keep JavaScript configuration hooks and deployed runtime sources, and preserve regression comparisons against an immutable, test-only reference artifact.
