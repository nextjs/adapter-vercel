---
"@next-community/adapter-vercel": patch
---

Give functions a prerender manifest without the fields that only configure the CDN, and without indentation, so that a cold start parses less. `NEXT_ADAPTER_VERCEL_DISABLE_FUNCTION_PRERENDER_MANIFEST=1` in the build environment turns this off
