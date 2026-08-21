---
"@next-community/adapter-vercel": patch
---

Emit `initialMetadata` on prerender configs. The group's primary output carries
`initialMetadata: { compute, htmlSize? }` copied verbatim from the Next.js
prerender taxonomy; sibling RSC/data/segment outputs and builds from older
Next.js versions omit the property, and `htmlSize` is absent when there is no
HTML shell to measure (route handlers, Pages Router) while `0` is a real size.
The values describe the deployment as it was built — revalidation can change a
route's behavior over the deployment's lifetime.
