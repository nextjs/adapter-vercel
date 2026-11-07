# Native adapter

`dist/index.js` is the only Next.js adapter hook. The hook calls
the packaged `adapter-vercel-<platform>-<arch>` executable and awaits completion
inside `onBuildComplete`, while Next.js's temporary traced assets still exist.

Linux, macOS and Windows x64/arm64 executables are declared in the package's `bin`
metadata so npm and pnpm preserve execute permission when packing and installing.

The native process handles public/static copying, ordered routing generation,
Node/Edge/Go function metadata, prerender aliases and fallback bodies, file hashes,
and runtime-template assembly. Handler templates are produced from the existing
runtime source during package build. The deployed runtime code is unchanged.
Edge assembly preserves source bytes while stripping the same inline source-map
comments as the reference. The existing adapter emits the assembled source, not
a separate composed source map.

The version-3 input includes the public hook context, unmodified configuration
JSON, explicit asset ordering and compiled image/function glob patterns. The
frame starts with `NXTADP3\n`, a little-endian uint32 JSON byte length, and the
UTF-8 JSON context. A little-endian uint32 map count follows, then each map's
uint32 length and uint32 binding references. Empty maps and reference order are
preserved. Go validates all section lengths before allocating the typed reference
storage. Internal version-1/2 JSON snapshots remain readable for diagnostics.
Module
resolution, JavaScript configuration mutation and shared platform policy remain
at the JavaScript boundary. Function policy is normalized once per configured
rule; Go performs matching and all per-output work. Unsupported protocol/runtime
values fail the build instead of silently falling back.

Config buffers are sized from shared-map lengths instead of retaining oversized
growth buffers. A 64MiB cap bounds the encoded config cache; output files remain
independent regular files so postbuild edits cannot affect other functions.
Source-file lookups are shared across outputs for the same source page. Function
writes reuse already-created parent directories without redundant probes.

Public/static output overlaps function generation. A single bounded worker pool
covers both paths, with `min(128, max(4, GOMAXPROCS * 4))` workers (16 on the
four-core benchmark container). `NEXT_ADAPTER_GO_WORKERS=1..128` overrides the
limit; `NEXT_ADAPTER_GO_OVERLAP=0` is a sequential control. Public precedes static,
and prerenders follow their parent functions. Constant function configuration
is encoded once and per-function options preserve the original merge order.
Output stays compatible with the current Build Output API; each function retains
its own regular config file for independent postbuild edits.

The production `modifyConfig` hook starts executable prefetch asynchronously,
overlapping compilation. `onBuildComplete` awaits any remaining read and falls
back to starting it there when the earlier hook ran in a different process.
`NEXT_ADAPTER_GO_PREFETCH_STAGE=complete` restores the previous start point for
controls; `NEXT_ADAPTER_GO_PREFETCH=0` disables prefetch. Timing logs include the
prefetch stage. Its complete read duration can occur outside the adapter timer,
but remains inside the full builder timer; only residual wait is on the adapter
critical path. Performance results must include both adapter and builder times.

Set `NEXT_ADAPTER_GO_PROFILE=1` on a diagnostic deployment to collect phase wall
times, allocation counts, runtime CPU settings and a labeled Go CPU profile.
The profile is emitted as indexed `[adapter-cpu-profile]` base64 chunks so it
can be recovered from remote build logs. Profiling runs include sampling and
profile-flush overhead and must be kept out of performance comparisons.

```sh
pnpm --filter @next-community/adapter-vercel test
```

Use Node.js 24 and a Go toolchain supporting `go.mod`. If the global Node version
has removed `--experimental-transform-types`, select Node.js 24 for the existing
package build script. Set `GOCACHE` to a writable directory in restricted local
environments.

The real-build fixture runs both implementations inside the same build hook and
compares output trees before Next.js cleans up temporary assets:

```sh
cd packages/adapter/test/fixtures/native-project
node ../../../node_modules/next/dist/bin/next build
NATIVE_PARITY_PPR=1 node ../../../node_modules/next/dist/bin/next build
```

It writes `.next/native-parity.json` on success. When a builder supplies
`NEXT_ADAPTER_PATH`, the fixture uses that entrypoint instead, enabling the full
native-builder-to-native-adapter integration check. Local results establish
correctness only; performance conclusions require matched remote Vercel builds.

The former JavaScript output generator is an immutable, test-only package
dependency. Behavioral tests invoke Go helpers through a test executable built
with `go test -c`; those operations are absent from the production binary.
Full-output comparisons load the frozen reference afresh for each configuration.
There is no JavaScript adapter output fallback in the shipped package.
