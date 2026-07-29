---
"@next-community/adapter-vercel": patch
---

Write the prerender taxonomy into `.prerender-config.json` as `prerenderClassification`, and set `sourcePath` to the source route matcher instead of the parent output pathname. Both come from Next.js `>= 16.3.0-canary.96`; on older versions `prerenderClassification` and `sourcePath` are omitted.
