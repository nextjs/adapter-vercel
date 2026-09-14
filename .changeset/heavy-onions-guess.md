---
"@next-community/adapter-vercel": patch
---

Emit server action meta routes so Firewall `server_action` rules and the `serverActionName` observability field work on adapter-built deployments. Each entry in `server-reference-manifest.json` produces a route matching the `next-action` request header that appends `x-server-action-name: <filename>#<exportedName>`, following the classic `@vercel/next` builder's `getServerActionMetaRoutes` behavior — except that any `$$RSC_SERVER_ACTION_*` exported name maps to `anonymous_fn` (the classic builder only renamed `$$RSC_SERVER_ACTION_0`), and ids duplicated across the node and edge manifests emit a single route.
