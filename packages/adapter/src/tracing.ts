import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { debug } from '@vercel/build-utils';

// .mjs, so webpack parses it as ESM even when the app's package.json sets
// "type": "commonjs". .vercel/otel/ has no package.json of its own.
const INJECT_ENTRY = './.vercel/otel/instrumentation.mjs';
const OTEL_API = '@opentelemetry/api';
// The image pins @opentelemetry/api 1.9.0, so @vercel/otel always resolves an
// API next to it, even when Next.js finds a copy the project root can't see
// (pnpm's node_modules/.pnpm/node_modules).
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
const IMAGE_OTEL_API = /^1\.9\.\d+$/;

// VERCEL_PROJECT_NAME is a system env var. When it's missing, @vercel/otel
// falls back to "app". A customer-set OTEL_SERVICE_NAME still wins.
// The import sits behind NEXT_RUNTIME, which Next.js inlines per runtime, so
// Edge bundles don't include @vercel/otel.
const WRAPPER_SOURCE = `export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerOTel } = await import('@vercel/otel')
    registerOTel({ serviceName: process.env.VERCEL_PROJECT_NAME })
  }
}
`;

type TracingConfig = {
  pageExtensions: readonly string[];
  outputFileTracingRoot: string;
  injectInstrumentation?: string[];
};

/**
 * Copies `@vercel/otel` from the build image into the project and adds a
 * wrapper to `injectInstrumentation`. `modifyConfig` decides whether default
 * tracing is enabled. Any failed check skips the inject without failing the
 * build.
 */
export async function injectDefaultTracing(
  config: TracingConfig,
  projectDir: string,
  packagesDir: string
): Promise<void> {
  try {
    if (await projectHasInstrumentation(projectDir, config)) {
      skip('project has an instrumentation file');
      return;
    }
    if (!(await otelApiIsCompatible(projectDir))) {
      skip('@opentelemetry/api is outside >=1.0.0 <1.10.0');
      return;
    }
    if (!(await imagePackagesExist(packagesDir))) {
      skip(`build image is missing one of ${COPIED_PACKAGES.join(', ')}`);
      return;
    }
    // A newer API breaks the SDK that @vercel/otel bundles (it caps the API
    // below 1.10), and an older one can't reach 1.9 readers.
    const imageApi = await readPackageVersion(
      path.join(packagesDir, OTEL_API, 'package.json'),
      OTEL_API
    );
    if (!imageApi || !IMAGE_OTEL_API.test(imageApi)) {
      skip(`build image has @opentelemetry/api ${imageApi}, not 1.9.x`);
      return;
    }

    const wrapper = await writeTracingTree(projectDir, packagesDir);
    // Throws, and so skips, if a copied package doesn't resolve from the wrapper.
    const requireFromWrapper = createRequire(wrapper);
    for (const name of COPIED_PACKAGES) requireFromWrapper.resolve(name);

    config.injectInstrumentation ??= [];
    if (!config.injectInstrumentation.includes(INJECT_ENTRY)) {
      config.injectInstrumentation.push(INJECT_ENTRY);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skip(message);
  }
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

async function imagePackagesExist(packagesDir: string): Promise<boolean> {
  for (const name of COPIED_PACKAGES) {
    if (!(await isDirectory(path.join(packagesDir, name)))) return false;
  }
  return true;
}

async function writeTracingTree(
  projectDir: string,
  packagesDir: string
): Promise<string> {
  const otelDir = path.join(projectDir, '.vercel', 'otel');
  const destModules = path.join(otelDir, 'node_modules');
  for (const name of COPIED_PACKAGES) {
    const source = path.join(packagesDir, name);
    const dest = path.join(destModules, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(source, dest, {
      recursive: true,
      dereference: true,
      force: true,
      // yarn 1 nests a newer @opentelemetry/api under api-logs for its "^1.3.0"
      // range. Skip nested copies so every package uses the pinned one.
      filter: (file) => !isNestedOtelApi(path.relative(source, file)),
    });
  }
  const wrapper = path.join(otelDir, 'instrumentation.mjs');
  await fs.writeFile(wrapper, WRAPPER_SOURCE);
  return wrapper;
}

function isNestedOtelApi(relative: string): boolean {
  const parts = relative.split(path.sep);
  return parts.some(
    (part, index) =>
      part === 'node_modules' &&
      parts[index + 1] === '@opentelemetry' &&
      parts[index + 2] === 'api'
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
