# Adapter build-output benchmark

This app models the adapter's workload in a large app build: nested pages
under a dynamic variant parameter, partial prerender shells, a small number
of route handlers, edge API routes, and middleware. It uses the
adapter built from this workspace. Edge functions are Pages Router API routes
in `pages/api/generated/`, because App Router rejects the `runtime` segment
config when `cacheComponents` is enabled. Each generated page produces a Node.js
function and RSC variant; the combinations of pages and variants produce
HTML, RSC, and segment prefetch prerender outputs.

From the repository root:

```sh
pnpm install
pnpm --filter @next-community/adapter-vercel build
BENCHMARK_PAGES=8 BENCHMARK_ROUTES=2 BENCHMARK_EDGE_ROUTES=2 BENCHMARK_VARIANTS=2 pnpm --filter @next-community/adapter-benchmark benchmark
```

For a full-size run, omit the environment variables. The defaults are 1,149
pages, 37 route handlers, 2,377 edge API routes, 1 variant, and 280
additional traced files per function. Adjust the counts to match the totals printed by the adapter;
outputs per route depend on the Next.js version. Build with the same settings
and filesystem as the workload you are comparing against. Run the command
twice to compare warm builds.

The timing logs include `node functions` and `prerenders` wall times and the
number of outputs. Semaphore wait and per-output summed times overlap across
workers; they are not extra time on top of wall time. Build outputs and the
generated pages and route handlers are ignored by Git.
