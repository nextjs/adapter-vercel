---
'@next-community/adapter-vercel': patch
---

Keep the existing TypeScript adapter as the default. Select the separate Go adapter only when NEXT_USE_GO_BUILDER=1, without importing native code or reading binaries for default builds.
