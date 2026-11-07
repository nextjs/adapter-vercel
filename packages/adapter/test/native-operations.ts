import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getLambdaOptionsFromFunction } from '@vercel/build-utils';
import minimatch from 'minimatch';
import type { AdapterOutput } from 'next';
import { prepareGoFunctions } from '../src/hosted-go';

export type FuncOutputs = Array<
  | AdapterOutput['APP_PAGE']
  | AdapterOutput['APP_ROUTE']
  | AdapterOutput['PAGES']
  | AdapterOutput['PAGES_API']
  | AdapterOutput['MIDDLEWARE']
>;
export type GoRouteOutput = AdapterOutput['APP_ROUTE'] & { runtime: 'go' };
const require = createRequire(import.meta.url);
const binary = fileURLToPath(
  new URL(
    `../.native-tests/adapter-tests${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url
  )
);

function invoke<T>(operation: string, input: unknown): T {
  const child = spawnSync(binary, [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, NEXT_ADAPTER_TEST_OPERATION: operation },
  });
  if (child.error) throw child.error;
  const response = JSON.parse(child.stdout);
  if (response.error)
    throw Object.assign(new Error(response.error.message), {
      code: response.error.code,
    });
  if (child.status !== 0)
    throw new Error(child.stderr || `Native contract failed (${child.status})`);
  return response.result;
}

async function context(options: Record<string, any>) {
  const builderConfig = JSON.parse(
    process.env.NEXT_ADAPTER_VERCEL_CONFIG || '{}'
  );
  const functionRules = await Promise.all(
    Object.entries(builderConfig.functions || {}).map(
      async ([pattern, values]) => ({
        pattern,
        regexp: minimatch.makeRe(pattern)!.source,
        options: await getLambdaOptionsFromFunction({
          sourceFile: pattern,
          config: { ...builderConfig, functions: { [pattern]: values } },
        }),
      })
    )
  );
  return {
    version: 1,
    config: options.config || {},
    configJSON: JSON.stringify(options.config || {}),
    projectDir: options.projectDir || options.vercelOutputDir,
    distDir: options.distDir || options.vercelOutputDir,
    repoRoot: options.repoRoot || options.projectDir || options.vercelOutputDir,
    nextVersion: options.nextVersion || '16.4.5',
    nodeRuntime: 'nodejs22.x',
    templatesDir: fileURLToPath(
      new URL('../dist/native-templates/', import.meta.url)
    ),
    nextEnvLoaderPath: require.resolve('@next/env'),
    outputDir: options.vercelOutputDir,
    functionRules,
    routing: {
      rsc: {
        contentTypeHeader: options.rscContentType,
        varyHeader: options.varyHeader,
      },
    },
    parents: options.nodeOutputsParentMap
      ? Object.fromEntries(options.nodeOutputsParentMap)
      : undefined,
    fallbacks: options.prerenderFallbackFalseMap,
  };
}

export function collectGoRouteOutputs(outputs: unknown): GoRouteOutput[] {
  return invoke('collectGoRouteOutputs', { outputs });
}
export async function handleGoOutputs(
  values: GoRouteOutput[],
  options: Record<string, any>
) {
  if (!values.length) return;
  collectGoRouteOutputs({ appRoutes: values });
  return invoke('handleGoOutputs', {
    ...(await context(options)),
    values,
    goFunctions: await prepareGoFunctions(values),
  });
}
export async function handleNodeOutputs(
  values: FuncOutputs,
  options: Record<string, any>
) {
  return invoke('handleNodeOutputs', {
    ...(await context(options)),
    values,
    middleware: !!options.isMiddleware,
  });
}
export async function handlePrerenderOutputs(
  values: unknown[],
  options: Record<string, any>
) {
  return invoke('handlePrerenderOutputs', {
    ...(await context(options)),
    values,
  });
}
export async function getSourceFilePathFromPage(
  params: Record<string, unknown>
): Promise<string> {
  return invoke('getSourceFilePathFromPage', { params });
}
export async function usesSrcDirectory(workPath: string): Promise<boolean> {
  return invoke('usesSrcDirectory', { params: { workPath } });
}
