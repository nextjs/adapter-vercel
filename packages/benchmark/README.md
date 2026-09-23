# Adapter build-output benchmark

This app exercises the two expensive `onBuildComplete` stages observed in a
large docs build: thousands of Node.js functions and tens of thousands of
prerender outputs. It uses the adapter built from this workspace and Next.js
16.3.0-canary.96. The `[slug]` page has a partial prerender shell (via
`loading.jsx`) and `generateStaticParams`; Next.js emits HTML, RSC and segment
prefetch outputs per generated page. The generated API routes produce distinct
Node.js functions and their RSC/data variants.

From the repository root:

```sh
pnpm install
pnpm --filter @next-community/adapter-vercel build
BENCHMARK_FUNCTIONS=8 BENCHMARK_PAGES=16 pnpm --filter @next-community/adapter-benchmark benchmark
```

For a full-size run, omit the two environment variables. The defaults are
1,196 API routes (roughly 2,400 node outputs) and 6,646 generated page paths
(roughly 40,000 prerender outputs); adjust the counts to match the totals
printed by the adapter (outputs per route depend on the Next.js version). Set
`BENCHMARK_FUNCTIONS=0` to isolate prerenders or `BENCHMARK_PAGES=1` to focus
on functions. Build with the same settings and filesystem as the workload you
are comparing against. Run the command twice to compare warm builds.

The timing logs include `node functions` and `prerenders` wall times and the
number of outputs. Semaphore wait and per-output summed times overlap across
workers; they are not extra time on top of wall time. Build outputs and the
generated route handlers are ignored by Git.
