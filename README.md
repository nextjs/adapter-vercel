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
