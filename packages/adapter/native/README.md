# Native adapter

`dist/native-adapter.js` is the Next.js adapter hook for this experiment;
`dist/index.js` remains the JavaScript reference implementation. The hook calls
the packaged `adapter-vercel-<platform>-<arch>` executable and awaits completion
inside `onBuildComplete`, while Next.js's temporary traced assets still exist.

Linux and macOS amd64/arm64 executables are declared in the package's `bin`
metadata so npm and pnpm preserve execute permission when packing and installing.

The native process handles public/static copying, ordered routing generation,
Node/Edge function metadata, prerender aliases and fallback bodies, file hashes,
and runtime-template assembly. Handler templates are produced from the existing
runtime source during package build. The deployed runtime code is unchanged.
Edge assembly preserves source bytes while stripping the same inline source-map
comments as the reference. The existing adapter emits the assembled source, not
a separate composed source map.

The version-1 input includes the public hook context, unmodified configuration
JSON, explicit asset ordering and compiled image/function glob patterns. Module
resolution, JavaScript configuration mutation and shared platform policy remain
at the JavaScript boundary. Function policy is normalized once per configured
rule; Go performs matching and all per-output work. Unsupported protocol/runtime
values fail the build instead of silently falling back.

```sh
pnpm --filter @next-community/adapter-vercel build
pnpm --filter @next-community/adapter-vercel exec vitest run
cd packages/adapter/native && go test -race ./...
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
