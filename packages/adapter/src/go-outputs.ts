import fs from 'node:fs/promises';
import path from 'node:path';
import { getLambdaOptionsFromFunction } from '@vercel/build-utils';
import type { AdapterOutput, NextConfig } from 'next';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { getSourceFilePathFromPage, usesSrcDirectory } from './outputs';

/** Proposed producer contract for the hosted Go route-handler proof of concept. */
export type GoRouteOutput = Omit<AdapterOutput['APP_ROUTE'], 'runtime'> & {
  runtime: 'go';
};

type OutputCollections = {
  appRoutes: readonly unknown[];
  appPages: readonly unknown[];
  pages: readonly unknown[];
  pagesApi: readonly unknown[];
  staticFiles: readonly unknown[];
  middleware?: unknown;
  prerenders: readonly { parentOutputId: string }[];
};

type PreparedGoFunction = {
  files: Record<string, { fsPath: string; mode: number }>;
  config: {
    runtime: 'executable';
    handler: 'executable';
    runtimeLanguage: 'go';
    architecture: 'x86_64';
    supportsResponseStreaming: true;
  };
};

type GoPackager = {
  version: 1;
  prepareGoFunction(options: {
    userServerPath: string;
  }): PreparedGoFunction | Promise<PreparedGoFunction>;
};

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

function assertGoRouteOutput(value: unknown): asserts value is GoRouteOutput {
  if (
    !isRecord(value) ||
    value.type !== AdapterOutputType.APP_ROUTE ||
    value.runtime !== 'go'
  ) {
    throw new Error(
      'Go is supported only for App Router route.go handler outputs'
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
  if (!value.sourcePage.endsWith('/route')) {
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
  const destinations = Object.keys(value.assets);
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
    const source = value.assets[destination];
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
export function collectGoRouteOutputs(
  outputs: OutputCollections
): GoRouteOutput[] {
  const goOutputs: GoRouteOutput[] = [];
  const collections = {
    appRoutes: outputs.appRoutes,
    appPages: outputs.appPages,
    pages: outputs.pages,
    pagesApi: outputs.pagesApi,
    staticFiles: outputs.staticFiles,
    middleware: outputs.middleware ? [outputs.middleware] : [],
  };
  for (const [kind, entries] of Object.entries(collections)) {
    for (const output of entries) {
      if (!isRecord(output) || !('runtime' in output)) continue;
      if (output.runtime === 'nodejs' || output.runtime === 'edge') continue;
      if (output.runtime !== 'go') {
        throw new Error(
          `Unsupported Next.js adapter output runtime: ${String(output.runtime)}`
        );
      }
      if (kind !== 'appRoutes') {
        throw new Error(
          `Go ${kind} outputs are unsupported; only App Router route.go handlers are supported`
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
    throw new Error(
      'Go route outputs cannot be prerender parents in this proof of concept'
    );
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
    packager.version !== 1 ||
    typeof packager.prepareGoFunction !== 'function'
  ) {
    throw new Error(
      'Unsupported @vercel/next Go packager: expected protocol version 1'
    );
  }
  return packager as GoPackager;
}

function assertPreparedGoFunction(
  value: unknown
): asserts value is PreparedGoFunction {
  if (!isRecord(value) || !isRecord(value.files) || !isRecord(value.config)) {
    throw new Error('Invalid Go packager response');
  }
  if (
    Object.keys(value.files).length !== 2 ||
    !Object.hasOwn(value.files, 'executable') ||
    !Object.hasOwn(value.files, 'user-server')
  ) {
    throw new Error(
      'Go packager must provide executable and user-server files'
    );
  }
  for (const file of Object.values(value.files)) {
    if (
      !isRecord(file) ||
      typeof file.fsPath !== 'string' ||
      !path.isAbsolute(file.fsPath) ||
      file.mode !== 0o755
    ) {
      throw new Error(
        'Go packager files must have absolute paths and mode 0755'
      );
    }
  }
  const config = value.config;
  if (
    config.runtime !== 'executable' ||
    config.handler !== 'executable' ||
    config.runtimeLanguage !== 'go' ||
    config.architecture !== 'x86_64' ||
    config.supportsResponseStreaming !== true
  ) {
    throw new Error(
      'Invalid Go executable runtime configuration from host packager'
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
    throw new Error(
      'Go preferredRegion="global" is unsupported in this proof of concept'
    );
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
  if (
    !isRecord(previousConfig) ||
    previousConfig.runtime !== 'executable' ||
    previousConfig.handler !== 'executable' ||
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

export async function handleGoOutputs(
  outputs: GoRouteOutput[],
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
  const builderConfig = JSON.parse(
    process.env.NEXT_ADAPTER_VERCEL_CONFIG || '{}'
  );
  const functionsDir = path.join(vercelOutputDir, 'functions');
  const usesSrcDir = await usesSrcDirectory(projectDir, 'app');
  const functionPaths = new Set<string>();
  for (const output of outputs) {
    assertGoRouteOutput(output);
    const pathname =
      output.pathname === '/' || output.pathname === config.basePath
        ? path.posix.join(output.pathname, 'index')
        : output.pathname;
    const functionPath = `${pathname.slice(1)}.func`.toLowerCase();
    if (functionPaths.has(functionPath))
      throw new Error(`Conflicting Go function output: ${pathname}`);
    functionPaths.add(functionPath);
  }
  for (const output of outputs) {
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
    const overrides = await getLambdaOptionsFromFunction({
      sourceFile,
      config: builderConfig,
    });
    const prepared: unknown = await packager.prepareGoFunction({
      userServerPath: output.filePath,
    });
    assertPreparedGoFunction(prepared);
    if (
      overrides.architecture &&
      overrides.architecture !== prepared.config.architecture
    ) {
      throw new Error(
        `Go target architecture conflicts with function configuration for ${sourceFile}`
      );
    }
    const pathname =
      output.pathname === '/' || output.pathname === config.basePath
        ? path.posix.join(output.pathname, 'index')
        : output.pathname;
    const functionDir = path.join(functionsDir, `${pathname.slice(1)}.func`);
    await ensureFunctionParent(functionsDir, functionDir);
    await existingGoFunction(functionDir);
    // Assemble in a fresh directory so reruns cannot retain stale assets or
    // follow a symlink left by a previous output. Preserve the prior function
    // if copying any of the replacement's files fails.
    const stagingDir = await fs.mkdtemp(
      path.join(path.dirname(functionDir), '.go-function-')
    );
    try {
      for (const [destination, source] of Object.entries(output.assets)) {
        const sourceStat = await fs.stat(source);
        if (!sourceStat.isFile())
          throw new Error(`Go asset is not a regular file: ${destination}`);
        const destinationPath = path.join(stagingDir, destination);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.copyFile(source, destinationPath);
        await fs.chmod(destinationPath, sourceStat.mode & 0o777);
      }
      for (const [destination, file] of Object.entries(prepared.files)) {
        await fs.copyFile(file.fsPath, path.join(stagingDir, destination));
        await fs.chmod(path.join(stagingDir, destination), file.mode);
      }
      // Deliberately omit Node launcher, multipayload and bundling properties.
      const functionConfig = {
        ...overrides,
        runtime: prepared.config.runtime,
        handler: prepared.config.handler,
        runtimeLanguage: prepared.config.runtimeLanguage,
        architecture: prepared.config.architecture,
        supportsResponseStreaming: prepared.config.supportsResponseStreaming,
        maxDuration: output.config.maxDuration ?? overrides.maxDuration,
        regions:
          overrides.regions ?? preferredRegions(output.config.preferredRegion),
        operationType: 'API',
        framework: { slug: 'nextjs', version: nextVersion },
      };
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
