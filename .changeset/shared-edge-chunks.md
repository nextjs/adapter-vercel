---
"@next-community/adapter-vercel": patch
---

Speed up edge function outputs: load chunks shared between edge functions once, read them in parallel, and skip parsing source maps that are never emitted
