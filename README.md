# Next.js Vercel Deployment Adapter

This repo contains the Vercel deployment adapter for Next.js. It does not need to be used directly as it will be auto configured when deploying on Vercel.

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

## Go route-handler proof of concept

The hosted adapter can package proposed Next.js Go outputs for App Router
`route.go` handlers. Next.js/Turbopack supplies an already compiled static Linux
x86_64 HTTP server; the adapter does not discover Go sources or compile them.
The producer contract is represented by `GoRouteOutput` in
`packages/adapter/src/go-outputs.ts`. It uses the usual `APP_ROUTE` output
fields with `runtime: 'go'`; no additional output keys are required.
The adapter resolves the existing `sourcePage` to an App Router `route.go` file,
using the same source resolver as Node.js with Go-aware extension handling and
`src/app` detection. That resolved path is used for per-function configuration.
The host validates the precompiled binary against the proof of concept's fixed
static Linux x86_64 requirement, and architecture overrides must agree with the
host's executable configuration.

A compatible `@vercel/next` host must supply
`NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH`, an absolute CommonJS module path. Version
1 of that module exports `version = 1` and
`prepareGoFunction({ userServerPath })`, returning executable file descriptors
and runtime metadata. The adapter copies the server, proxy, and declared assets
into a separate `.func` directory for each Go output. Asset destinations are
relative to the function root, which is also the server's working directory.
The `executable`, `user-server`, and `.vc-config.json` names are reserved.

Go outputs do not participate in Node.js function grouping. Go route bundling,
Go pages, middleware, prerender parents, arm64, and CGO/native dependencies are
outside this proof of concept. Existing Node.js output handling and grouping
remain enabled in mixed deployments. The IPC proxy completes invocations when
the HTTP response ends; post-response work has no completion guarantee and
there is no `after()`/`waitUntil` completion protocol.
