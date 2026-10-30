---
'@next-community/adapter-vercel': patch
---

Package Go App Router handler outputs as separate executable functions when hosted by a compatible @vercel/next builder. Reuse existing output fields with runtime set to go, preserve Node.js output grouping, and reject unsupported Go output kinds and incompatible architecture overrides.
