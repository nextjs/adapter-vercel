---
'@next-community/adapter-vercel': patch
---

Add a separate Go adapter output generator behind NEXT_USE_GO_BUILDER=1. Keep the existing TypeScript adapter as the default, preserve deployed runtime sources, and retain full-output regression comparisons against the maintained default TypeScript implementation.
