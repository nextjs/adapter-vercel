---
"@next-community/adapter-vercel": patch
---

Register `nextConfig` on the router server context so the route module does not fall back to the config inside `required-server-files.json`, which Next deep-freezes when it caches the manifest.

A dependency that requires `next/image` from `node_modules` rather than through the bundle reads that config during render and sorts `images.deviceSizes` in place, throwing `Cannot assign to read only property '0' of object '[object Array]'`.
