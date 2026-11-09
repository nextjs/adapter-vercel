---
'@next-community/adapter-vercel': patch
---

Retain root-level function settings when src/pages or src/app is a regular file, and reject public FIFO pipes and sockets with the existing TypeScript adapter's errors.
