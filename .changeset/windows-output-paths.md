---
"@next-community/adapter-vercel": patch
---

Write `/`-separated paths in function configs when building on Windows. `filePathMap`, `fileHashes`, handler paths and prerender fallbacks used to get native paths there (for example `../C:\repo\.next\server\app\page.js`), so `vercel deploy --prebuilt` couldn't find the files. A file on a different drive from the project now fails the build with a clear error.
