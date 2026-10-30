import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { debug } from '@vercel/build-utils';

// .mjs, so webpack parses it as ESM even when the app's package.json sets
// "type": "commonjs". .vercel/otel/ has no package.json of its own.
const INJECT_ENTRY = './.vercel/otel/instrumentation.mjs';
const COPIED_PACKAGES = ['@vercel/otel', '@opentelemetry/api-logs'] as const;
const OTEL_API = '@opentelemetry/api';
// Accepted @opentelemetry/api range: >=1.6.0 <1.10.0. @vercel/otel 2.x declares
// >=1.9.0, but only uses API features that 1.6.0 has, and Next.js vendors 1.6.0
// for apps without their own copy. OpenTelemetry JS SDK 2.x, which @vercel/otel
// 2.x bundles, caps the API below 1.10.
const OTEL_API_MIN_MINOR = 6;
const OTEL_API_MAX_MINOR = 9;

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
      skip('@opentelemetry/api is outside >=1.6.0 <1.10.0');
      return;
    }
    if (!(await imagePackagesExist(packagesDir))) {
      skip('build image is missing @vercel/otel or @opentelemetry/api-logs');
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

async function otelApiIsCompatible(projectDir: string): Promise<boolean> {
  if (!isResolvable(projectDir, OTEL_API)) return true;
  const version = await resolvedPackageVersion(projectDir, OTEL_API);
  return version !== undefined && otelApiVersionOk(version);
}

function isResolvable(projectDir: string, name: string): boolean {
  try {
    createRequire(path.join(projectDir, 'package.json')).resolve(name);
    return true;
  } catch {
    return false;
  }
}

function otelApiVersionOk(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return (
    major === 1 && minor >= OTEL_API_MIN_MINOR && minor <= OTEL_API_MAX_MINOR
  );
}

async function resolvedPackageVersion(
  projectDir: string,
  name: string
): Promise<string | undefined> {
  let entry: string;
  try {
    entry = createRequire(path.join(projectDir, 'package.json')).resolve(name);
  } catch {
    return undefined;
  }

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
    const dest = path.join(destModules, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(path.join(packagesDir, name), dest, {
      recursive: true,
      dereference: true,
      force: true,
      // Skip any nested @opentelemetry/api, so @vercel/otel uses the app's
      // copy if it has one, or Next.js's vendored copy. Next.js's spans and
      // the provider then share one API.
      filter: (source) => {
        const parts = source.split(path.sep);
        return !parts.some(
          (part, index) =>
            part === '@opentelemetry' && parts[index + 1] === 'api'
        );
      },
    });
  }
  const wrapper = path.join(otelDir, 'instrumentation.mjs');
  await fs.writeFile(wrapper, WRAPPER_SOURCE);
  return wrapper;
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
