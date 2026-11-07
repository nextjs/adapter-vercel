# Next.js Vercel Deployment Adapter

This repo contains the Vercel deployment adapter for Next.js. It does not need to be used directly as it will be auto configured when deploying on Vercel.

The adapter uses a single Go output generator. Next.js loads `dist/index.js` for
its configuration and build hooks; that small bridge resolves Node-specific
metadata and launches the packaged native executable. Routing, function and
asset packaging run in Go. Deployed Node.js and Edge runtime sources remain
unchanged. Linux, macOS and Windows executables for x64 and arm64 ship with the
package, so applications do not need a Go compiler.

`pnpm test` builds the adapter, runs the behavioral tests against Go, compares
complete output trees against an immutable test-only JavaScript reference, and
runs the Go race detector. The reference is a pinned published development
dependency; its output generator is neither maintained here nor shipped in the
adapter bundle.

For debugging use cases you can install this package locally and configure it in your `next.config`. It is recommended to leave this automatically configured to receive automatic fixes.

```sh
npm i @next-community/adapter-vercel@latest
```

```ts
// next.config.ts
import { NextConfig } from 'next' 

const nextConfig: NextConfig = {
  experimental: {
    adapterPath: require.resolve('@next-community/adapter-vercel')
  }
}

export default nextConfig
```
