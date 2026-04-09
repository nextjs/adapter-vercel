---
"@next-community/adapter-vercel": patch
---

Normalize `x-nextjs-data` headers by removing them on non-`/_next/data` requests before route resolution.
