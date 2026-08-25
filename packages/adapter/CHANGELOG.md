# @next-community/adapter-vercel

## 0.0.1-beta.29

### Patch Changes

- [#109](https://github.com/nextjs/adapter-vercel/pull/109) [`1ce60ee`](https://github.com/nextjs/adapter-vercel/commit/1ce60eefe6af1060b0464ffec94c690e777aa866) Thanks [@devjiwonchoi](https://github.com/devjiwonchoi)! - Revert "Do not fall back to URL when manifest unmatched (#88)"

- [#107](https://github.com/nextjs/adapter-vercel/pull/107) [`c7ff79d`](https://github.com/nextjs/adapter-vercel/commit/c7ff79d46ae217be17d56afdbeb66162dac7a59f) Thanks [@lubakravche](https://github.com/lubakravche)! - Emit `initialMetadata` on prerender configs. The group's primary output carries
  `initialMetadata: { compute, htmlSize? }` copied verbatim from the Next.js
  prerender taxonomy; sibling RSC/data/segment outputs and builds from older
  Next.js versions omit the property, and `htmlSize` is absent when there is no
  HTML shell to measure (route handlers, Pages Router) while `0` is a real size.
  The values describe the deployment as it was built — revalidation can change a
  route's behavior over the deployment's lifetime.

## 0.0.1-beta.28

### Patch Changes

- [#88](https://github.com/nextjs/adapter-vercel/pull/88) [`7785ac3`](https://github.com/nextjs/adapter-vercel/commit/7785ac3b8bc78aab91a3b52c054f29eba0ff7362) Thanks [@devjiwonchoi](https://github.com/devjiwonchoi)! - Return 404 before loading a request path that does not match a bundled route.

## 0.0.1-beta.27

### Patch Changes

- [#100](https://github.com/nextjs/adapter-vercel/pull/100) [`a1a3083`](https://github.com/nextjs/adapter-vercel/commit/a1a30834de3e1d1d7a05dc22227234ba12fb6a8c) Thanks [@unstubbable](https://github.com/unstubbable)! - Declare the postponed state length of a partially prerendered output in bytes

## 0.0.1-beta.26

### Patch Changes

- [#101](https://github.com/nextjs/adapter-vercel/pull/101) [`15edb66`](https://github.com/nextjs/adapter-vercel/commit/15edb66f9e02363a9520e7386ab01d16297fb4ee) Thanks [@ztanner](https://github.com/ztanner)! - Revert "Fix i18n routing for API paths"- #101

## 0.0.1-beta.25

### Patch Changes

- [#95](https://github.com/nextjs/adapter-vercel/pull/95) [`4719a17`](https://github.com/nextjs/adapter-vercel/commit/4719a175becb3781e988ace86478f17415b590b5) Thanks [@nsidnev](https://github.com/nsidnev)! - Assign `deploymentId` from `VERCEL_DEPLOYMENT_ID` in `modifyConfig` and to `process.env.NEXT_DEPLOYMENT_ID` when Skew Protection is enabled and the platform did not inject `NEXT_DEPLOYMENT_ID` (e.g. services deployments).

- [#81](https://github.com/nextjs/adapter-vercel/pull/81) [`6ac41c9`](https://github.com/nextjs/adapter-vercel/commit/6ac41c9f0ae12a073ccce92252c1dc3cf8bd5ab5) Thanks [@timneutkens](https://github.com/timneutkens)! - Prevent i18n routing from adding or removing locale prefixes for API routes.

## 0.0.1-beta.24

### Patch Changes

- [#73](https://github.com/nextjs/adapter-vercel/pull/73) [`4a360d7`](https://github.com/nextjs/adapter-vercel/commit/4a360d7eab46e5c1ff6a115b29d89f9419e7a479) Thanks [@mischnic](https://github.com/mischnic)! - Fix lint warnings and improve typecoverage

- [#76](https://github.com/nextjs/adapter-vercel/pull/76) [`31618ec`](https://github.com/nextjs/adapter-vercel/commit/31618ec7c4c5ba1ab0220d363454242c005d3717) Thanks [@mischnic](https://github.com/mischnic)! - Remove peerDependency on next

- [#77](https://github.com/nextjs/adapter-vercel/pull/77) [`a9ed91f`](https://github.com/nextjs/adapter-vercel/commit/a9ed91f694059f46b3bf33bdaa434cf3c0569dfb) Thanks [@mischnic](https://github.com/mischnic)! - Fix usesSrcDirectory regression

## 0.0.1-beta.23

### Patch Changes

- [#72](https://github.com/nextjs/adapter-vercel/pull/72) [`0632be8`](https://github.com/nextjs/adapter-vercel/commit/0632be8bac10a1b52fd3b74af78e39cb347c3c4b) Thanks [@mischnic](https://github.com/mischnic)! - Fix usesSrcDirectory caching

- [#69](https://github.com/nextjs/adapter-vercel/pull/69) [`0873c41`](https://github.com/nextjs/adapter-vercel/commit/0873c418264cf1d424facf5416f1a068ce34f599) Thanks [@andrewimm](https://github.com/andrewimm)! - Fix output type tracking for API routes

- [#70](https://github.com/nextjs/adapter-vercel/pull/70) [`6a2df2a`](https://github.com/nextjs/adapter-vercel/commit/6a2df2a2b301b9e37d45bd9702fe42f013eeb26a) Thanks [@mischnic](https://github.com/mischnic)! - Allow overriding supportsImmutableAssets from infra

## 0.0.1-beta.22

### Patch Changes

- [#66](https://github.com/nextjs/adapter-vercel/pull/66) [`74e1c0c`](https://github.com/nextjs/adapter-vercel/commit/74e1c0c8357d31da2bc792833098cf89f7120689) Thanks [@mischnic](https://github.com/mischnic)! - ctx.projectDir might be undefined on older versions

## 0.0.1-beta.21

### Patch Changes

- [#24](https://github.com/nextjs/adapter-vercel/pull/24) [`d7dd58d`](https://github.com/nextjs/adapter-vercel/commit/d7dd58d3747aa155bf5381a8ad055766db73b456) Thanks [@mischnic](https://github.com/mischnic)! - Include fileHashes for function files

- [#65](https://github.com/nextjs/adapter-vercel/pull/65) [`54b2026`](https://github.com/nextjs/adapter-vercel/commit/54b202610df9b611433d3a104f67c6627db68ac0) Thanks [@mischnic](https://github.com/mischnic)! - Pass through vercel-toolbar to instrumentationClientInject

## 0.0.1-beta.20

### Patch Changes

- [#60](https://github.com/nextjs/adapter-vercel/pull/60) [`c727b5e`](https://github.com/nextjs/adapter-vercel/commit/c727b5e38c483bf24afff31cfa7959fbb0e640ef) Thanks [@ijjk](https://github.com/ijjk)! - Ignore example environment variables

## 0.0.1-beta.19

### Patch Changes

- [#52](https://github.com/nextjs/adapter-vercel/pull/52) [`60d936f`](https://github.com/nextjs/adapter-vercel/commit/60d936fe443ec55beec224db5d2e5a1ef9aa4012) Thanks [@ijjk](https://github.com/ijjk)! - Preserve `maxDuration` from `vercel.json` in generated node function config.

## 0.0.1-beta.18

### Patch Changes

- [`eaa7309`](https://github.com/nextjs/adapter-vercel/commit/eaa7309d106e0410bc7b27471f09e43d3428ecd7) Thanks [@ijjk](https://github.com/ijjk)! - Support VERCEL_IMMUTABLE_STATIC_FILES_ENABLED and VERCEL_HASH_SALT

## 0.0.1-beta.17

### Patch Changes

- [#48](https://github.com/nextjs/adapter-vercel/pull/48) [`2dc4ff5`](https://github.com/nextjs/adapter-vercel/commit/2dc4ff54d4bb4c43f9839b036c2ab8b8daef227a) Thanks [@ijjk](https://github.com/ijjk)! - Normalize `x-nextjs-data` headers by removing them on non-`/_next/data` requests before route resolution.

## 0.0.1-beta.16

### Patch Changes

- [#46](https://github.com/nextjs/adapter-vercel/pull/46) [`99a684d`](https://github.com/nextjs/adapter-vercel/commit/99a684dd678418b9e9b870a1fb90d03938663709) Thanks [@ijjk](https://github.com/ijjk)! - Handle .env files in node output path

## 0.0.1-beta.15

### Patch Changes

- [#44](https://github.com/nextjs/adapter-vercel/pull/44) [`bf92584`](https://github.com/nextjs/adapter-vercel/commit/bf9258497bc69d6ba9a966b33d09d8e05e50c095) Thanks [@ijjk](https://github.com/ijjk)! - fix(adapter): pass vercel config into getNodeVersion

## 0.0.1-beta.14

### Patch Changes

- [#41](https://github.com/nextjs/adapter-vercel/pull/41) [`50a522a`](https://github.com/nextjs/adapter-vercel/commit/50a522ae3f75849faedc57ed4443e3ce9e96b028) Thanks [@ijjk](https://github.com/ijjk)! - Normalize regions for edge outputs

## 0.0.1-beta.13

### Patch Changes

- [#39](https://github.com/nextjs/adapter-vercel/pull/39) [`1b25751`](https://github.com/nextjs/adapter-vercel/commit/1b25751f6a61e6533a99f776c7016e8e0cea2d8d) Thanks [@ijjk](https://github.com/ijjk)! - Update `@vercel/build-utils` to `13.6.2` and include `partialFallback` in prerender config output.

## 0.0.1-beta.12

### Patch Changes

- [#37](https://github.com/nextjs/adapter-vercel/pull/37) [`610e7c2`](https://github.com/nextjs/adapter-vercel/commit/610e7c2ddb98abbcbb4bc688b822d3afc5a48810) Thanks [@ijjk](https://github.com/ijjk)! - Fix lambda typing and payloads field

## 0.0.1-beta.11

### Patch Changes

- [#35](https://github.com/nextjs/adapter-vercel/pull/35) [`3329c8f`](https://github.com/nextjs/adapter-vercel/commit/3329c8f15764cbe0e35c1e8ea306d64563355abc) Thanks [@ijjk](https://github.com/ijjk)! - Ensure supportsMultiPayload field set

## 0.0.1-beta.10

### Patch Changes

- [#33](https://github.com/nextjs/adapter-vercel/pull/33) [`38a9bb5`](https://github.com/nextjs/adapter-vercel/commit/38a9bb541ae174254773a2c9a8e7317ce52a118a) Thanks [@ijjk](https://github.com/ijjk)! - Fix initURL including empty query

## 0.0.1-beta.9

### Patch Changes

- [#32](https://github.com/nextjs/adapter-vercel/pull/32) [`3c0b285`](https://github.com/nextjs/adapter-vercel/commit/3c0b2851058581214f8a513210bda7eaafd1afc9) Thanks [@ijjk](https://github.com/ijjk)! - Remove debug logs

- [#30](https://github.com/nextjs/adapter-vercel/pull/30) [`1917018`](https://github.com/nextjs/adapter-vercel/commit/1917018dc9473fd306b4504b265d383f710f40b4) Thanks [@ijjk](https://github.com/ijjk)! - Make sure initURL is absolute

## 0.0.1-beta.8

### Patch Changes

- [#28](https://github.com/nextjs/adapter-vercel/pull/28) [`798e7df`](https://github.com/nextjs/adapter-vercel/commit/798e7df93112b99452d2ed2f7b5cf64f13d1e799) Thanks [@ijjk](https://github.com/ijjk)! - Ensure initURL is initialized

## 0.0.1-beta.7

### Patch Changes

- [#26](https://github.com/nextjs/adapter-vercel/pull/26) [`1ed977f`](https://github.com/nextjs/adapter-vercel/commit/1ed977f778bce54eda866d6383bd763d86e58401) Thanks [@ijjk](https://github.com/ijjk)! - adapter: apply generated step/workflow config overrides

## 0.0.1-beta.6

### Patch Changes

- [#22](https://github.com/nextjs/adapter-vercel/pull/22) [`42146f3`](https://github.com/nextjs/adapter-vercel/commit/42146f3d0e283b20eb7c349f3741f7b893816230) Thanks [@ijjk](https://github.com/ijjk)! - Fix edge middleware entry name

## 0.0.1-beta.5

### Patch Changes

- [#20](https://github.com/nextjs/adapter-vercel/pull/20) [`68a7427`](https://github.com/nextjs/adapter-vercel/commit/68a74276f1d47951d5b5f19125ea65b6fe269c97) Thanks [@mischnic](https://github.com/mischnic)! - Strip routes-manifest.json for determinism more

## 0.0.1-beta.4

### Patch Changes

- [#17](https://github.com/nextjs/adapter-vercel/pull/17) [`98bc1a3`](https://github.com/nextjs/adapter-vercel/commit/98bc1a33abe9ae41d30c20c0bbecf8380a94432b) Thanks [@mischnic](https://github.com/mischnic)! - Strip routes-manifest.json for determinism

- [#18](https://github.com/nextjs/adapter-vercel/pull/18) [`fbd123b`](https://github.com/nextjs/adapter-vercel/commit/fbd123b897df6249b0cc4432c75d8408b9b00d23) Thanks [@mischnic](https://github.com/mischnic)! - Fix build to make flattenSourceMap work

## 0.0.1-beta.3

### Patch Changes

- [#15](https://github.com/nextjs/adapter-vercel/pull/15) [`40d87c2`](https://github.com/nextjs/adapter-vercel/commit/40d87c216cdcf4d9bb78bff77541a9500550ab59) Thanks [@ijjk](https://github.com/ijjk)! - Leverage setup-node-env instead of internal paths

## 0.0.1-beta.2

### Patch Changes

- [#13](https://github.com/nextjs/adapter-vercel/pull/13) [`77a2f24`](https://github.com/nextjs/adapter-vercel/commit/77a2f24b6888d8d08ea797787407f3c8fa7d073e) Thanks [@ijjk](https://github.com/ijjk)! - Update edge function limit

## 0.0.1-beta.1

### Patch Changes

- [#11](https://github.com/nextjs/adapter-vercel/pull/11) [`92f63c3`](https://github.com/nextjs/adapter-vercel/commit/92f63c33a59ce05e57846bd189ecbe32ae925b6d) Thanks [@ijjk](https://github.com/ijjk)! - Apply fixes for handler interface and resume

## 0.0.1-beta.0

### Patch Changes

- [`1c3641d`](https://github.com/nextjs/adapter-vercel/commit/1c3641df779ea2e52f76b9a1d2655809df7f4f44) Thanks [@ijjk](https://github.com/ijjk)! - Trigger release
