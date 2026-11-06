import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { debug } from '@vercel/build-utils';

// The Vercel builder copies @vercel/otel, @opentelemetry/api-logs and a pinned
// @opentelemetry/api 1.9 from the build image to .vercel/otel/ once, before
// `next build`, and writes this wrapper next to them. It sits in node_modules
// so ESLint and Prettier skip it by default. .mjs, so webpack parses it as ESM
// even when the app's package.json sets "type": "commonjs".
const INJECT_ENTRY = './.vercel/otel/node_modules/instrumentation.mjs';
const OTEL_API = '@opentelemetry/api';
const COPIED_PACKAGES = [
  '@vercel/otel',
  '@opentelemetry/api-logs',
  OTEL_API,
] as const;
// Every 1.x API copy shares one global slot and accepts a provider registered
// by the same or a newer minor version, so registering through 1.9 reaches any
// reader from 1.0 to 1.9. A 1.10+ reader rejects it, a 2.x reader uses another
// slot, and a prerelease reader only accepts its exact version.
const OTEL_API_MAX_MINOR = 9;

type TracingConfig = {
  pageExtensions: readonly string[];
  outputFileTracingRoot: string;
  instrumentationInject?: string[];
};

/**
 * Adds the builder's tracing wrapper to `instrumentationInject`. `modifyConfig`
 * decides whether default tracing is enabled. Any failed check skips the
 * inject without failing the build.
 */
export async function injectDefaultTracing(
  config: TracingConfig,
  projectDir: string
): Promise<void> {
  try {
    if (await projectHasInstrumentation(projectDir, config)) {
      skip('project has an instrumentation file');
      return;
    }
    // Another setter, such as a config wrapper, already injected instrumentation.
    // It may register its own provider, so don't add a second one.
    if (config.instrumentationInject?.some((entry) => entry !== INJECT_ENTRY)) {
      skip('instrumentationInject already has other entries');
      return;
    }
    if (!(await otelApiIsCompatible(projectDir))) {
      skip('@opentelemetry/api is outside >=1.0.0 <1.10.0');
      return;
    }
    const wrapper = path.join(projectDir, INJECT_ENTRY);
    if (!(await isFile(wrapper))) {
      skip('the builder did not prepare .vercel/otel');
      return;
    }
    // Node resolution falls back to the project's node_modules, so a package
    // missing from the tree could resolve to the app's own copy.
    const treeModules = await fs.realpath(path.dirname(wrapper));
    for (const name of COPIED_PACKAGES) {
      const resolved = resolveFrom(wrapper, name);
      if (!resolved || !isInside(treeModules, resolved)) {
        skip(`.vercel/otel is missing ${name}`);
        return;
      }
    }

    config.instrumentationInject ??= [];
    if (!config.instrumentationInject.includes(INJECT_ENTRY)) {
      config.instrumentationInject.push(INJECT_ENTRY);
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
  if (!Array.isArray(entries) || !entries.includes(INJECT_ENTRY)) return false;
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

// Checks the copy the app's own code resolves, and the copy Next.js's tracer
// resolves from its own folder, which pnpm can hide from the project root.
async function otelApiIsCompatible(projectDir: string): Promise<boolean> {
  const fromProject = path.join(projectDir, 'package.json');
  const fromNext = resolveFrom(fromProject, 'next/package.json');
  for (const from of fromNext ? [fromProject, fromNext] : [fromProject]) {
    const entry = resolveFrom(from, OTEL_API);
    if (!entry) continue;
    const version = await packageVersion(entry, OTEL_API);
    if (version === undefined || !otelApiVersionOk(version)) return false;
  }
  return true;
}

function resolveFrom(from: string, request: string): string | undefined {
  try {
    return createRequire(from).resolve(request);
  } catch {
    return undefined;
  }
}

// Prereleases fail the pattern: the API only accepts an exact version match
// when either side has one.
function otelApiVersionOk(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return (
    match !== null &&
    Number(match[1]) === 1 &&
    Number(match[2]) <= OTEL_API_MAX_MINOR
  );
}

async function packageVersion(
  entry: string,
  name: string
): Promise<string | undefined> {
  let dir = path.dirname(entry);
  for (;;) {
    const version = await readPackageVersion(
      path.join(dir, 'package.json'),
      name
    );
    if (version) return version;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function readPackageVersion(
  pkgPath: string,
  name: string
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch {
    return undefined;
  }
  return versionOf(raw, name);
}

function versionOf(raw: string, name: string): string | undefined {
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof pkg !== 'object' || pkg === null) return undefined;
  if (!('name' in pkg) || pkg.name !== name) return undefined;
  if (!('version' in pkg) || typeof pkg.version !== 'string') return undefined;
  return pkg.version;
}

function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
