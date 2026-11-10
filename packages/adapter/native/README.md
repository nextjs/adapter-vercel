# Native adapter

Next.js loads `dist/index.js` for the adapter's configuration and build hooks.
The JavaScript entrypoint handles module resolution, configuration mutation,
and shared platform policy. Its `onBuildComplete` hook invokes the packaged
`adapter-vercel-<platform>-<arch>` executable and waits for completion while
Next.js's temporary traced assets still exist.

The native process handles public/static copying, ordered route generation,
Node/Edge/Go function metadata, prerender aliases and fallback bodies, file
hashes, and runtime-template assembly. Templates are generated from the existing
runtime source during package build. Each function has independent regular
output files so later build steps can modify them independently.

## Distribution

Linux, macOS, and Windows executables for x64 and arm64 are compiled with CGO
disabled and included in the package. Their `bin` metadata preserves executable
permissions when npm or pnpm packs and installs the package. Required module
licenses are included in the distribution. Applications do not need to install
Go to run the adapter.

## Transport and output ordering

The version-3 request includes the public hook context, configuration JSON,
explicit asset ordering, and compiled image/function glob patterns. Its frame
contains `NXTADP3\n`, a little-endian uint32 JSON byte length, and the UTF-8 JSON
context, followed by a little-endian uint32 map count and each map's uint32
length and uint32 binding references. Repeated paths and hashes share bindings;
empty maps and reference order are preserved. Go validates section lengths
before allocating reference storage. Internal version-1/2 JSON requests remain
readable for diagnostics.

A bounded worker pool handles static copying and function generation. Public
assets precede static assets, and prerenders follow their parent functions.
Routing and configuration merge order are preserved. Unsupported protocol or
runtime values fail the build. The shipped adapter has no JavaScript output
generator fallback.

## Diagnostics

`NEXT_NATIVE_BUILD_TIMINGS=1` emits adapter timings to build logs.
`NEXT_ADAPTER_GO_PROFILE=1` adds phase timings, allocation counts, CPU settings,
and a labeled Go CPU profile. Profiles are emitted as indexed
`[adapter-cpu-profile]` base64 chunks. Profiling adds sampling and flush overhead
and should be enabled only for diagnosis.

The production `modifyConfig` hook prefetches the executable asynchronously,
overlapping Next.js compilation. `onBuildComplete` waits for any remaining read
or starts it if the configuration hook ran in another process. For diagnosis,
`NEXT_ADAPTER_GO_PREFETCH_STAGE=complete` defers prefetch to the build-completion
hook, and `NEXT_ADAPTER_GO_PREFETCH=0` disables it. Timing logs distinguish the
full prefetch duration from the residual wait on the build-completion path.

`NEXT_ADAPTER_GO_WORKERS=1..128` overrides the worker count, and
`NEXT_ADAPTER_GO_OVERLAP=0` serializes static copying and function generation.

## Build and test

Use Node.js 24, the repository's configured pnpm version, and a Go toolchain
compatible with [go.mod](./go.mod). Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @next-community/adapter-vercel build
pnpm --filter @next-community/adapter-vercel test
```

The former JavaScript output generator is an immutable, test-only dependency.
Behavioral tests invoke Go helpers through a test executable built with
`go test -c`; those operations are absent from the production binary.
Full-output comparisons load the reference afresh for each configuration.

The real-build fixture compares both implementations inside the same build
hook, before Next.js cleans up temporary assets:

```sh
cd packages/adapter/test/fixtures/native-project
node ../../../node_modules/next/dist/bin/next build
NATIVE_PARITY_PPR=1 node ../../../node_modules/next/dist/bin/next build
```

It writes `.next/native-parity.json` on success. When a builder supplies
`NEXT_ADAPTER_PATH`, the fixture uses that entrypoint instead, allowing the same
application to exercise the native builder and adapter together.
