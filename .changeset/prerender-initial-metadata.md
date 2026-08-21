---
"@next-community/adapter-vercel": patch
---

Emit `initialMetadata` on prerender configs. The group's primary output carries
`initialMetadata: { compute }` copied verbatim from the Next.js prerender
taxonomy; sibling RSC/data/segment outputs and builds from older Next.js
versions omit the property. The values describe the deployment as it was
built — revalidation can change a route's behavior over the deployment's
lifetime.
