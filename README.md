# Next.js Vercel Deployment Adapter

The Vercel deployment adapter for Next.js is configured automatically when
deploying on Vercel. Applications normally do not need to install or configure
this package directly.

The existing TypeScript adapter is used by default. Set
`NEXT_USE_GO_BUILDER=1` to opt into the separate Go output generator. Next.js
loads a small selector that delegates configuration and build hooks to the
selected implementation. Deployed runtime implementations are unchanged.

On Vercel, the same variable opts into the Go builder as well when
`NEXT_ENABLE_ADAPTER=1` is enabled. Unset it or set it to `0` to use TypeScript.

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

The tests exercise the default TypeScript path and the opt-in Go path, compare
complete output trees against the maintained TypeScript implementation, and
run the Go race detector. Tests load TypeScript directly so opt-in cannot
accidentally make both sides of a comparison use Go. Both output generators
are shipped separately.
