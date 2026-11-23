import fs from 'node:fs/promises';
import path from 'node:path';
import { getLambdaOptionsFromFunction } from '@vercel/build-utils';
import type { AdapterOutput, NextAdapter, NextConfig } from 'next';
import { AdapterOutputType } from 'next/constants';
import { getSourceFilePathFromPage, normalizeIndexPathname } from './outputs';

export type GoRouteOutput = AdapterOutput['APP_ROUTE'] & {
  runtime: 'go';
};

export type GoMiddlewareOutput = AdapterOutput['MIDDLEWARE'] & {
  runtime: 'go';
};
export type GoOutput = GoRouteOutput | GoMiddlewareOutput;

type BuildOutputs = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]['outputs'];

/** A container image built by the host, in a registry or a staged OCI layout. */
type PreparedGoContainer = {
  handler: string;
  image?: { type: 'oci-layout'; directory: string };
};

type PreparedGoExecutable = {
  files: Record<'executable' | 'user-server', { fsPath: string; mode: number }>;
};

type PreparedGoFunction = PreparedGoContainer | PreparedGoExecutable;

/**
 * Protocol version 2: the host chooses packaging and the adapter writes functions.
 * close releases build resources, including any staged OCI layouts.
 */
type GoPackager = {
  version: 2;
  prepareGoFunction(options: {
    userServerPath: string;
    type: 'route' | 'middleware';
  }): PreparedGoFunction | Promise<PreparedGoFunction>;
  close?(): void | Promise<void>;
};

const GO_PACKAGER_VERSION = 2;
const IMAGE_DIR = 'image';

const RESERVED_NAMES = new Set([
  'executable',
  'user-server',
  '.vc-config.json',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRelativeFilePath(
  value: unknown,
  description: string
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `Invalid Go ${description}: expected a normalized relative file path`
    );
  }
}

function assertPathname(
  value: unknown,
  description = 'output pathname'
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('?') ||
    value.includes('#') ||
    (value !== '/' &&
      value
        .slice(1)
        .split('/')
        .some((part) => !part || part === '.' || part === '..'))
  ) {
    throw new Error(`Invalid Go ${description}`);
  }
}

function assertGoRouteOutput(value: unknown): asserts value is GoOutput {
  if (
    !isRecord(value) ||
    (value.type !== AdapterOutputType.APP_ROUTE &&
      value.type !== AdapterOutputType.MIDDLEWARE) ||
    value.runtime !== 'go'
  ) {
    throw new Error(
      'Go is supported only for App Router route.go handlers and proxy.go middleware outputs'
    );
  }
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.sourcePage !== 'string'
  ) {
    throw new Error('Go outputs require a route id and sourcePage');
  }
  assertPathname(value.pathname);
  assertPathname(value.sourcePage, 'sourcePage');
  if (value.type === AdapterOutputType.MIDDLEWARE) {
    if (
      !['/proxy', '/src/proxy'].includes(value.sourcePage) ||
      value.pathname !== '/_middleware' ||
      !isRecord(value.config) ||
      !Array.isArray(value.config.matchers)
    ) {
      throw new Error(
        'Go middleware requires a root or src proxy.go source, /_middleware pathname, and matchers'
      );
    }
  } else if (!value.sourcePage.endsWith('/route')) {
    throw new Error('Go sourcePage must identify an App Router route handler');
  }
  if (typeof value.filePath !== 'string' || !path.isAbsolute(value.filePath)) {
    throw new Error(
      'Go filePath must be an absolute path to the precompiled server'
    );
  }
  if (
    !isRecord(value.assets) ||
    !isRecord(value.assetsHashes) ||
    !isRecord(value.config)
  ) {
    throw new Error(
      'Go outputs require assets, assetsHashes, and config objects'
    );
  }
}

async function resolveGoSourceFile(
  output: GoOutput,
  projectDir: string,
  usesSrcDir: boolean
): Promise<string> {
  if (output.type === AdapterOutputType.MIDDLEWARE) {
    const sourceFile = `${output.sourcePage.slice(1)}.go`;
    if (!(await fs.stat(path.join(projectDir, sourceFile))).isFile())
      throw new Error(`Could not resolve Go proxy source: ${sourceFile}`);
    return sourceFile;
  }
  const sourceFile = (
    await getSourceFilePathFromPage({
      workPath: projectDir,
      page: output.sourcePage,
      pageExtensions: ['go'],
      usesSrcDir,
      pageTypes: ['app'],
      allowExtensionless: false,
      allowDirectoryIndex: false,
    })
  ).replace(/\\/g, '/');
  if (!/^(src\/)?app\/(?:.*\/)?route\.go$/.test(sourceFile)) {
    throw new Error(
      `Could not resolve Go route.go source for ${output.sourcePage}`
    );
  }
  return sourceFile;
}

function assertGoAssets(assets: GoOutput['assets']): void {
  const destinations = Object.keys(assets);
  const portableDestinations = new Set<string>();
  const portablePaths = new Map<string, string>();
  for (const destination of destinations) {
    assertRelativeFilePath(destination, 'asset destination');
    const portableDestination = destination.toLowerCase();
    if (RESERVED_NAMES.has(portableDestination.split('/')[0])) {
      throw new Error(`Reserved Go function asset destination: ${destination}`);
    }
    if (portableDestinations.has(portableDestination)) {
      throw new Error(`Conflicting Go asset destinations: ${destination}`);
    }
    portableDestinations.add(portableDestination);
    const parts = destination.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const portablePrefix = prefix.toLowerCase();
      const previous = portablePaths.get(portablePrefix);
      if (previous && previous !== prefix) {
        throw new Error(`Conflicting Go asset destinations: ${destination}`);
      }
      portablePaths.set(portablePrefix, prefix);
    }
    const source = assets[destination];
    if (typeof source !== 'string' || !path.isAbsolute(source)) {
      throw new Error(
        `Go asset ${destination} requires an absolute source path`
      );
    }
  }
  for (const destination of portableDestinations) {
    const parts = destination.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (portableDestinations.has(parts.slice(0, i).join('/'))) {
        throw new Error(`Conflicting Go asset destinations: ${destination}`);
      }
    }
  }
}

/** Validate before any output is materialized; Node/Edge retain their existing paths. */
export function collectGoRouteOutputs(outputs: BuildOutputs): GoOutput[] {
  const goOutputs: GoOutput[] = [];
  for (const kind of [
    'appRoutes',
    'appPages',
    'pages',
    'pagesApi',
    'staticFiles',
    'middleware',
  ] as const) {
    const entries =
      kind === 'middleware'
        ? outputs.middleware
          ? [outputs.middleware]
          : []
        : outputs[kind];
    for (const candidate of entries) {
      const output: unknown = candidate;
      if (!isRecord(output) || !('runtime' in output)) continue;
      if (output.runtime === 'nodejs' || output.runtime === 'edge') continue;
      if (output.runtime !== 'go') {
        throw new Error(
          `Unsupported Next.js adapter output runtime: ${String(output.runtime)}`
        );
      }
      if (kind !== 'appRoutes' && kind !== 'middleware') {
        throw new Error(
          `Go ${kind} outputs are unsupported; only App Router route.go handlers are supported`
        );
      }
      if (
        kind === 'middleware' &&
        output.type !== AdapterOutputType.MIDDLEWARE
      ) {
        throw new Error(
          'Go middleware outputs are unsupported unless they use the MIDDLEWARE output type'
        );
      }
      if (kind === 'appRoutes' && output.type !== AdapterOutputType.APP_ROUTE) {
        throw new Error(
          'Go App Router outputs require the APP_ROUTE output type'
        );
      }
      assertGoRouteOutput(output);
      goOutputs.push(output);
    }
  }
  const goIds = new Set<string>();
  for (const output of goOutputs) {
    if (goIds.has(output.id))
      throw new Error(`Duplicate Go output id: ${output.id}`);
    goIds.add(output.id);
  }
  if (outputs.prerenders.some((output) => goIds.has(output.parentOutputId))) {
    throw new Error('Go route outputs cannot be prerender parents');
  }
  return goOutputs;
}

function loadGoPackager(): GoPackager {
  const modulePath = process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH;
  if (!modulePath || !path.isAbsolute(modulePath)) {
    throw new Error(
      'Go outputs require a hosted @vercel/next Go packager (NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH)'
    );
  }
  const packager: unknown = require(modulePath);
  if (
    !isRecord(packager) ||
    packager.version !== GO_PACKAGER_VERSION ||
    typeof packager.prepareGoFunction !== 'function' ||
    (packager.close !== undefined && typeof packager.close !== 'function')
  ) {
    throw new Error(
      `Unsupported @vercel/next Go packager: expected protocol version ${GO_PACKAGER_VERSION}`
    );
  }
  return packager as GoPackager;
}

function hasExactKeys(
  value: unknown,
  keys: string[]
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isGoExecutableFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.fsPath === 'string' &&
    path.isAbsolute(value.fsPath) &&
    value.mode === 0o755 &&
    Object.keys(value).every((key) => key === 'fsPath' || key === 'mode')
  );
}

function assertPreparedGoFunction(
  value: unknown
): asserts value is PreparedGoFunction {
  if (isRecord(value) && 'files' in value) {
    if (
      !hasExactKeys(value, ['files']) ||
      !hasExactKeys(value.files, ['executable', 'user-server']) ||
      !isGoExecutableFile(value.files.executable) ||
      !isGoExecutableFile(value.files['user-server'])
    ) {
      throw new Error(
        'Go packager must provide executable and user-server files'
      );
    }
    return;
  }
  if (
    !isRecord(value) ||
    typeof value.handler !== 'string' ||
    !value.handler ||
    Object.keys(value).some((key) => key !== 'handler' && key !== 'image')
  ) {
    throw new Error(
      'Go packager must return a container image handler and optional image'
    );
  }
  if (
    value.image !== undefined &&
    (!isRecord(value.image) ||
      value.image.type !== 'oci-layout' ||
      typeof value.image.directory !== 'string' ||
      !path.isAbsolute(value.image.directory) ||
      Object.keys(value.image).some(
        (key) => key !== 'type' && key !== 'directory'
      ))
  ) {
    throw new Error(
      'Go packager image must be an OCI layout with an absolute directory'
    );
  }
}

function preferredRegions(
  preferredRegion: string | string[] | undefined
): string[] | undefined {
  if (!preferredRegion) return undefined;
  const regions =
    typeof preferredRegion === 'string' ? [preferredRegion] : preferredRegion;
  if (regions.includes('global')) {
    throw new Error('Go preferredRegion="global" is unsupported');
  }
  if (regions.includes('auto')) return undefined;
  const normalized = regions.flatMap((region) =>
    region === 'home'
      ? (process.env.VERCEL_FUNCTION_REGIONS || '').split(',').filter(Boolean)
      : [region]
  );
  return normalized.length ? normalized : undefined;
}

function outputCollision(functionDir: string): Error {
  return Object.assign(
    new Error(`Refusing to replace a non-Go function output: ${functionDir}`),
    { code: 'EEXIST' }
  );
}

async function existingGoFunction(functionDir: string): Promise<boolean> {
  const stat = await fs
    .lstat(functionDir)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw outputCollision(functionDir);
  }
  const configPath = path.join(functionDir, '.vc-config.json');
  const previousConfig = await (async (): Promise<unknown> => {
    try {
      const configStat = await fs.lstat(configPath);
      if (!configStat.isFile() || configStat.isSymbolicLink()) return undefined;
      return JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch {
      return undefined;
    }
  })();
  // Recognize containers and executable functions from earlier adapter builds.
  if (
    !isRecord(previousConfig) ||
    (previousConfig.runtime !== 'container' &&
      !(
        previousConfig.runtime === 'executable' &&
        previousConfig.handler === 'executable'
      )) ||
    previousConfig.runtimeLanguage !== 'go' ||
    !isRecord(previousConfig.framework) ||
    previousConfig.framework.slug !== 'nextjs'
  ) {
    throw outputCollision(functionDir);
  }
  return true;
}

async function ensureFunctionParent(functionsDir: string, functionDir: string) {
  await fs.mkdir(functionsDir, { recursive: true });
  let current = functionsDir;
  const relativeParent = path.relative(functionsDir, path.dirname(functionDir));
  for (const part of ['', ...relativeParent.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    if (part) {
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw outputCollision(functionDir);
    }
  }
}

async function usesSrcAppDirectory(workPath: string): Promise<boolean> {
  try {
    if ((await fs.stat(path.join(workPath, 'app'))).isDirectory()) {
      return false;
    }
  } catch (_err) {}
  try {
    return (await fs.stat(path.join(workPath, 'src', 'app'))).isDirectory();
  } catch (_err) {
    return false;
  }
}

export async function handleGoOutputs(
  outputs: GoOutput[],
  {
    config,
    projectDir,
    nextVersion,
    vercelOutputDir,
  }: {
    config: NextConfig;
    projectDir: string;
    nextVersion: string;
    vercelOutputDir: string;
  }
): Promise<void> {
  if (!outputs.length) return;
  const packager = loadGoPackager();
  let closeFailure: { error: unknown } | undefined;
  try {
    await writeGoFunctions(packager, outputs, {
      config,
      projectDir,
      nextVersion,
      vercelOutputDir,
    });
  } finally {
    try {
      await packager.close?.();
    } catch (error) {
      // Defer cleanup errors so a build failure keeps its original error.
      closeFailure = { error };
    }
  }
  if (closeFailure) throw closeFailure.error;
}

async function writeGoFunctions(
  packager: GoPackager,
  outputs: GoOutput[],
  {
    config,
    projectDir,
    nextVersion,
    vercelOutputDir,
  }: {
    config: NextConfig;
    projectDir: string;
    nextVersion: string;
    vercelOutputDir: string;
  }
): Promise<void> {
  const builderConfig = JSON.parse(
    process.env.NEXT_ADAPTER_VERCEL_CONFIG || '{}'
  );
  const functionsDir = path.join(vercelOutputDir, 'functions');
  const usesSrcDir = await usesSrcAppDirectory(projectDir);
  const functionPaths = new Map<string, string>();
  for (const output of outputs) {
    assertGoRouteOutput(output);
    const pathname =
      output.type === AdapterOutputType.MIDDLEWARE
        ? output.pathname
        : normalizeIndexPathname(output.pathname, config);
    const functionPath = `${pathname.slice(1)}.func`;
    const caseInsensitivePath = functionPath.toLowerCase();
    const previous = functionPaths.get(caseInsensitivePath);
    // Identical paths retain Node's last-output-wins behavior for root/index aliases.
    if (previous && previous !== functionPath)
      throw new Error(`Conflicting Go function output: ${pathname}`);
    functionPaths.set(caseInsensitivePath, functionPath);
  }

  // Prepare concurrently, but wait for every build to settle before writing
  // functions or closing the packager, including when one image build fails.
  const results = await Promise.allSettled(
    outputs.map(async (output) => {
      const sourceFile = await resolveGoSourceFile(
        output,
        projectDir,
        usesSrcDir
      );
      const overrides = await getLambdaOptionsFromFunction({
        sourceFile,
        config: builderConfig,
      });
      if (overrides.architecture && overrides.architecture !== 'x86_64') {
        throw new Error(
          `Go target architecture conflicts with function configuration for ${sourceFile}`
        );
      }
      const regions =
        overrides.regions ?? preferredRegions(output.config.preferredRegion);
      const packaged: unknown = await packager.prepareGoFunction({
        userServerPath: output.filePath,
        type:
          output.type === AdapterOutputType.MIDDLEWARE ? 'middleware' : 'route',
      });
      assertPreparedGoFunction(packaged);
      if ('files' in packaged) {
        assertGoAssets(output.assets);
      } else if (Object.keys(output.assets).length > 0) {
        throw new Error(
          `Go function ${sourceFile} cannot include separate assets because it runs as a container image. Embed them in the executable, for example with go:embed.`
        );
      }
      const pathname =
        output.type === AdapterOutputType.MIDDLEWARE
          ? output.pathname
          : normalizeIndexPathname(output.pathname, config);
      return {
        functionDir: path.join(functionsDir, `${pathname.slice(1)}.func`),
        // Deliberately omit Node launcher, multipayload and bundling properties.
        functionConfig: {
          ...overrides,
          ...('files' in packaged
            ? {
                runtime: 'executable',
                handler: 'executable',
              }
            : {
                runtime: 'container',
                handler: packaged.handler,
                ...(packaged.image && {
                  image: { type: 'oci-layout', path: IMAGE_DIR },
                }),
              }),
          runtimeLanguage: 'go',
          architecture: 'x86_64',
          supportsResponseStreaming: true,
          maxDuration: output.config.maxDuration ?? overrides.maxDuration,
          regions,
          operationType: 'API',
          framework: { slug: 'nextjs', version: nextVersion },
        },
        packaged,
        assets: output.assets,
      };
    })
  );
  const prepared = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });

  for (const { functionDir, functionConfig, packaged, assets } of prepared) {
    await ensureFunctionParent(functionsDir, functionDir);
    await existingGoFunction(functionDir);
    // Assemble in a fresh directory so reruns cannot retain stale files or
    // follow a symlink left by a previous output. Preserve the prior function
    // if assembling the replacement fails.
    const stagingDir = await fs.mkdtemp(
      path.join(path.dirname(functionDir), '.go-function-')
    );
    try {
      if ('files' in packaged) {
        for (const [destination, source] of Object.entries(assets)) {
          const sourceStat = await fs.stat(source);
          if (!sourceStat.isFile())
            throw new Error(`Go asset is not a regular file: ${destination}`);
          const destinationPath = path.join(stagingDir, destination);
          await fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await fs.copyFile(source, destinationPath);
          await fs.chmod(destinationPath, sourceStat.mode & 0o777);
        }
        for (const [destination, file] of Object.entries(packaged.files)) {
          await fs.copyFile(file.fsPath, path.join(stagingDir, destination));
          await fs.chmod(path.join(stagingDir, destination), file.mode);
        }
      } else if (packaged.image) {
        // Shared executables can share a staged layout, possibly on another
        // filesystem, so copy it instead of moving it into a function.
        await fs.cp(
          packaged.image.directory,
          path.join(stagingDir, IMAGE_DIR),
          {
            recursive: true,
            errorOnExist: true,
            force: false,
          }
        );
      }
      await fs.writeFile(
        path.join(stagingDir, '.vc-config.json'),
        JSON.stringify(functionConfig, null, 2)
      );
      if (await existingGoFunction(functionDir)) {
        await fs.rm(functionDir, { recursive: true });
      }
      await fs.rename(stagingDir, functionDir);
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }
}
