---
'@next-community/adapter-vercel': patch
---

Add a separate Go build-output generator, enabled with `NEXT_USE_GO_BUILDER=1`. Keep the existing TypeScript adapter as the default and retain the Build Output API format, configuration hooks, deployed runtime sources, and Node.js, Edge, and Go route support.

Bundle native executables for Linux, macOS, and Windows on x64 and arm64. Preserve routing, function configuration, asset handling, hashes, and filesystem permissions, with output comparisons against the maintained TypeScript implementation.
