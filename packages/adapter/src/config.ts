import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextAdapter } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { generateToolbarScript } from './toolbar';

export async function modifyConfig(
  config: Parameters<NonNullable<NextAdapter['modifyConfig']>>[0],
  ctx: Parameters<NonNullable<NextAdapter['modifyConfig']>>[1]
) {
  if (ctx.phase === PHASE_PRODUCTION_BUILD && process.env.CI) {
    // A workaround to speedup Turbopack builds (particularly warm builds). Vercel build cache
    // reads currently slows down dramatically with too many concurrent reads, so we limit to 4.
    process.env.TURBO_ENGINE_READ_CONCURRENCY = '4';
  }

  if (ctx.phase === PHASE_PRODUCTION_BUILD) {
    config.experimental.supportsImmutableAssets =
      // Default to true, allow users to opt-out
      (config.experimental.supportsImmutableAssets ?? true) &&
      // AND with infra support to allow disabling via feature flag if necessary.
      process.env.VERCEL_IMMUTABLE_STATIC_FILES_ENABLED === '1';
  }

  if (process.env.VERCEL_HASH_SALT != null) {
    config.experimental.outputHashSalt =
      (config.experimental.outputHashSalt ?? '') + process.env.VERCEL_HASH_SALT;
  }

  // This fallback covers builds where the `NEXT_DEPLOYMENT_ID` variable is missing,
  // e.g. services deployments, where the framework is resolved per-service
  // at the build time.
  if (
    ctx.phase === PHASE_PRODUCTION_BUILD &&
    process.env.VERCEL_SKEW_PROTECTION_ENABLED === '1' &&
    process.env.VERCEL_DEPLOYMENT_ID &&
    !process.env.NEXT_DEPLOYMENT_ID &&
    config.deploymentId == null
  ) {
    config.deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  }

  if (
    ctx.phase === PHASE_PRODUCTION_BUILD &&
    process.env.VERCEL_PREVIEW_COMMENTS_ENABLED === '1' &&
    // Only available in newer Next.js versions
    typeof ctx.projectDir !== 'undefined'
  ) {
    // This script has to live inside of the project directory since Turbopack can't read file
    // files outside of the project directory.
    const dir = path.join(ctx.projectDir, '.vercel/');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'adapter-toolbar-script.js'),
      generateToolbarScript(
        process.env.VERCEL_ENV === 'production',
        process.env.VERCEL_PREVIEW_COMMENTS_OPT_IN === '1',
        process.env.VERCEL_SKEW_PROTECTION_ENABLED === '1'
          ? 'process.env.NEXT_DEPLOYMENT_ID'
          : // Fallback to burning in the deployment id if skew protection is disabled
            'process.env.NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID'
      )
    );

    config.instrumentationClientInject ??= [];
    config.instrumentationClientInject.push(
      `./.vercel/adapter-toolbar-script.js`
    );
  }

  return config;
}
