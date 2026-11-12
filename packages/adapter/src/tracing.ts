import fs from 'node:fs/promises';
import path from 'node:path';
import { debug } from '@vercel/build-utils';

// Before `next build`, the Vercel builder decides whether the deployment gets
// default tracing, checks the build image and the project's
// @opentelemetry/api, and only then writes a wrapper next to a copy of
// @vercel/otel under .vercel/otel/. It names the wrapper's entry in
// VERCEL_DEFAULT_NEXT_TRACING_ENTRY only when it prepared it in this build, so a
// file the build command writes or restores later isn't injected.
const ENTRY_DIR = './.vercel/otel/';

// Entries outside .vercel/otel/ are ignored, so a stray env var can't inject
// an arbitrary module.
function preparedEntry(): string | undefined {
  const entry = process.env.VERCEL_DEFAULT_NEXT_TRACING_ENTRY;
  if (!entry?.startsWith(ENTRY_DIR) || entry.split('/').includes('..')) {
    return undefined;
  }
  return entry;
}

type TracingConfig = {
  pageExtensions: readonly string[];
  outputFileTracingRoot: string;
  instrumentationInject?: string[];
};

/**
 * Adds the builder's tracing wrapper to `instrumentationInject` when the
 * builder prepared it in this build, unless the config already has
 * instrumentation of its own. These checks need the resolved config, so only
 * the adapter can make them. Any failed check skips the inject without failing
 * the build.
 */
export async function injectDefaultTracing(
  config: TracingConfig,
  projectDir: string
): Promise<void> {
  try {
    const entry = preparedEntry();
    if (!entry) {
      skip('the builder did not prepare .vercel/otel');
      return;
    }
    if (await projectHasInstrumentation(projectDir, config)) {
      skip('project has an instrumentation file');
      return;
    }
    // Another setter, such as a config wrapper, already injected instrumentation.
    // It may register its own provider, so don't add a second one.
    if (config.instrumentationInject?.some((other) => other !== entry)) {
      skip('instrumentationInject already has other entries');
      return;
    }
    if (!(await isFile(path.join(projectDir, entry)))) {
      skip('the prepared wrapper is missing');
      return;
    }

    config.instrumentationInject ??= [];
    if (!config.instrumentationInject.includes(entry)) {
      config.instrumentationInject.push(entry);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skip(message);
  }
}

/**
 * Whether the build actually compiled the default tracing inject. Next.js
 * versions without `instrumentationInject` ignore the entry, so the config
 * alone isn't enough: the compiled server instrumentation entry must exist.
 * When it does, @vercel/otel instruments fetch, so the runtime's own fetch
 * spans would duplicate them.
 */
export async function defaultTracingWasInjected(
  config: object,
  distDir: string
): Promise<boolean> {
  // Next.js types before the field existed don't declare it.
  const entries =
    'instrumentationInject' in config
      ? config.instrumentationInject
      : undefined;
  const entry = preparedEntry();
  if (!entry || !Array.isArray(entries) || !entries.includes(entry)) {
    return false;
  }
  return isFile(path.join(distDir, 'server', 'instrumentation.js'));
}

// Only printed with VERCEL_BUILDER_DEBUG=1, so customer build logs stay quiet.
function skip(reason: string): void {
  debug(`Skipping Vercel tracing inject: ${reason}`);
}

// Next.js chains injected instrumentation before the project's own file, so
// skip whenever Next.js would find one. Turbopack looks in the project and each
// parent folder up to the tracing root, at the folder itself and in `src/`.
async function projectHasInstrumentation(
  projectDir: string,
  config: Pick<TracingConfig, 'pageExtensions' | 'outputFileTracingRoot'>
): Promise<boolean> {
  const root = path.resolve(config.outputFileTracingRoot);
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'src')]) {
      for (const ext of config.pageExtensions) {
        if (await isFile(path.join(base, `instrumentation.${ext}`))) {
          return true;
        }
      }
    }
    const relative = path.relative(root, dir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
