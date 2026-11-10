# Next.js Vercel Deployment Adapter

The Vercel deployment adapter for Next.js is configured automatically when
deploying on Vercel. Applications normally do not need to install or configure
this package directly.

The adapter uses Go to generate routes, function metadata, and static outputs.
Next.js loads a small JavaScript entrypoint for configuration and build hooks,
which invokes the packaged native executable. Deployed runtime implementations
are unchanged.

The package includes Linux, macOS, and Windows executables for x64 and arm64.
Applications do not need a Go compiler to run the adapter. See the
[native adapter documentation](./packages/adapter/native/README.md) for
architecture, diagnostics, and validation details.

## Manual configuration

For local debugging or use outside automatic Vercel configuration, install the
adapter in an application using a Next.js release with adapter support:

```sh
npm install @next-community/adapter-vercel
```

```ts
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  adapterPath: require.resolve('@next-community/adapter-vercel'),
}

export default nextConfig
```

Leave adapter selection to Vercel for normal deployments so the platform can
supply compatible adapter updates.

## Development

Use Node.js 24, the repository's configured pnpm version, and a Go toolchain
compatible with [go.mod](./packages/adapter/native/go.mod).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The tests exercise the Go implementation, compare complete output trees against
an immutable JavaScript reference, and run the Go race detector. The reference
is a pinned development dependency used only by tests; its output generator is
not shipped in the adapter bundle.
