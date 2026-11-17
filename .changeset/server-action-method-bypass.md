---
'@next-community/adapter-vercel': patch
---

Use a POST method rule for Server Action cache bypasses on App Page prerenders. GET and HEAD requests no longer bypass the prerender cache solely because they carry an action-related header.
