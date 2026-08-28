---
"@next-community/adapter-vercel": patch
---

Emit server action meta routes so Firewall `server_action` rules and the `serverActionName` observability field work on adapter-built deployments. Each entry in `server-reference-manifest.json` produces a route matching the `next-action` request header that appends `x-server-action-name: <filename>#<exportedName>`, matching the classic `@vercel/next` builder's `getServerActionMetaRoutes` behavior.
