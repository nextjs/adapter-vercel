---
"@next-community/adapter-vercel": patch
---

Assign `deploymentId` from `VERCEL_DEPLOYMENT_ID` in `modifyConfig` and to `process.env.NEXT_DEPLOYMENT_ID` when Skew Protection is enabled and the platform did not inject `NEXT_DEPLOYMENT_ID` (e.g. services deployments).
