---
"@next-community/adapter-vercel": minor
---

Write Go route handlers and proxy middleware as container functions using version 2 of the hosted Go packager contract. The packager returns an image handler and an optional staged OCI layout, and may provide a close hook for build cleanup. Version 1 packagers are no longer supported. Separate Go assets are no longer allowed; embed them in the executable with `go:embed`.
