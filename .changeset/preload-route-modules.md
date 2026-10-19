---
"@next-community/adapter-vercel": patch
---

Export `preload` from the Node handler when `NEXT_PRIVATE_PRELOAD_ENTRIES` is set, so instances initialized ahead of traffic load their route modules before the first request, like the previous launcher.
