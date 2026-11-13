---
"@next-community/adapter-vercel": patch
---

Key the hashes of project `.env` files by their `filePathMap` path, so every env file in a function's `.vc-config.json` has a matching `fileHashes` entry when the Next.js app is not at the repository root.
