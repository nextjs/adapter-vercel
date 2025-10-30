import path from 'node:path';
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import { Sema } from 'async-sema';
import type { AdapterOutput, NextConfig } from 'next';
import type { VercelConfig } from './types';
import type { RouteWithSrc } from '@vercel/routing-utils';
import type { NextjsParams } from './get-edge-function';
import { getHandlerSource } from './node-handler';
import {
  getLambdaOptionsFromFunction,
  getNodeVersion,
} from '@vercel/build-utils';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { getNextjsEdgeFunctionSource } from './get-edge-function-source';
import { INTERNAL_PAGES } from './constants';

const copy = async (src: string, dest: string) => {
  await fse.remove(dest);
  await fse.copy(src, dest);
};

const writeLock = new Map<string, Promise<any>>();

const writeIfNotExists = async (filePath: string, content: string) => {
  await writeLock.get(filePath);

  const writePromise = fs
    .writeFile(filePath, content, { flag: 'wx' })
    .catch((err) => {
      if (err.code === 'EEXIST') return;
      throw err;
    })
    .finally(() => writeLock.delete(filePath));

  writeLock.set(filePath, writePromise);
  return writePromise;
};

export async function handlePublicFiles(
  publicFolder: string,
  vercelOutputDir: string,
  config: NextConfig
) {
  const topLevelItems = await fs.readdir(publicFolder).catch(() => []);
  const fsSema = new Sema(16, { capacity: topLevelItems.length });

  await Promise.all(
    topLevelItems.map(async (item) => {
      await fsSema.acquire();

      const destination = path.join(
        vercelOutputDir,
        'static',
        config.basePath || '',
        item
      );
      const destDirectory = path.dirname(destination);

      await fs.mkdir(destDirectory, { recursive: true });
      await copy(path.join(publicFolder, item), destination);

      fsSema.release();
    })
  );
}

export async function handleStaticOutputs(
  outputs: Array<AdapterOutput['STATIC_FILE']>,
  {
    config,
    vercelConfig,
    vercelOutputDir,
  }: {
    config: NextConfig;
    vercelConfig: VercelConfig;
    vercelOutputDir: string;
  }
) {
  const fsSema = new Sema(16, { capacity: outputs.length });

  await Promise.all(
    outputs.map(async (output) => {
      await fsSema.acquire();

      const srcExtension = path.extname(output.filePath);

      // Automatically statically optimized pages should
      // be output to static folder but apply content-type override
      // and path to remove the extension
      const isHtml = srcExtension === '.html';

      if (isHtml) {
        vercelConfig.overrides[
          path.posix.join('./', output.pathname + '.html')
        ] = {
          contentType: 'text/html; charset=utf-8',
          path: path.posix.join('./', output.pathname),
        };
      }
      const destination = path.join(
        vercelOutputDir,
        'static',
        output.pathname + (isHtml ? '.html' : '')
      );
      const destDirectory = path.dirname(destination);

      await fs.mkdir(destDirectory, { recursive: true });
      await copy(output.filePath, destination);

      fsSema.release();
    })
  );

  await fs.writeFile(
    path.posix.join(
      vercelOutputDir,
      'static',
      config.basePath || '',
      '_next/static/not-found.txt'
    ),
    'Not Found'
  );
}

const vercelConfig = JSON.parse(process.env.NEXT_ADAPTER_VERCEL_CONFIG || '{}');

export type FuncOutputs = Array<
  | AdapterOutput['PAGES']
  | AdapterOutput['APP_PAGE']
  | AdapterOutput['APP_ROUTE']
  | AdapterOutput['PAGES_API']
  | AdapterOutput['MIDDLEWARE']
>;

export async function handleNodeOutputs(
  nodeOutputs: FuncOutputs,
  {
    config,
    distDir,
    repoRoot,
    projectDir,
    nextVersion,
    isMiddleware,
    prerenderFallbackFalseMap,
    vercelOutputDir,
  }: {
    config: NextConfig;
    distDir: string;
    repoRoot: string;
    projectDir: string;
    nextVersion: string;
    isMiddleware?: boolean;
    prerenderFallbackFalseMap: Record<string, string[]>;
    vercelOutputDir: string;
  }
) {
  const nodeVersion = await getNodeVersion(projectDir, undefined, {}, {});

  const fsSema = new Sema(16, { capacity: nodeOutputs.length });
  const functionsDir = path.join(vercelOutputDir, 'functions');
  const handlerRelativeDir = path.posix.relative(repoRoot, projectDir);

  let pages404Output: undefined | FuncOutputs[0];
  let pagesErrorOutput: undefined | FuncOutputs[0];

  for (const item of nodeOutputs) {
    if (item.pathname === path.posix.join('/', config.basePath || '', '/404')) {
      pages404Output = item;
    }
    if (
      item.pathname === path.posix.join('/', config.basePath || '', '/_error')
    ) {
      pagesErrorOutput = item;
    }

    if (pages404Output && pagesErrorOutput) {
      break;
    }
  }

  await Promise.all(
    nodeOutputs.map(async (output) => {
      await fsSema.acquire();

      const functionDir = path.join(
        functionsDir,
        `${output.pathname === '/' ? '/index' : output.pathname}.func`
      );
      await fs.mkdir(functionDir, { recursive: true });

      const files: Record<string, string> = {};

      for (const [relPath, fsPath] of Object.entries(output.assets)) {
        files[relPath] = path.posix.relative(repoRoot, fsPath);
      }
      files[path.posix.relative(repoRoot, output.filePath)] =
        path.posix.relative(repoRoot, output.filePath);

      // ensure 404 handler is included in function for rendering
      // not-found in pages router
      if (output.type === AdapterOutputType.PAGES) {
        const notFoundOutput = pages404Output || pagesErrorOutput;

        if (notFoundOutput) {
          for (const [relPath, fsPath] of Object.entries(
            notFoundOutput.assets
          )) {
            files[relPath] = path.posix.relative(repoRoot, fsPath);
          }
          files[path.posix.relative(repoRoot, notFoundOutput.filePath)] =
            path.posix.relative(repoRoot, notFoundOutput.filePath);
        }
      }

      const handlerFilePath = path.join(
        functionDir,
        handlerRelativeDir,
        '___next_launcher.cjs'
      );

      await fs.mkdir(path.dirname(handlerFilePath), { recursive: true });
      await writeIfNotExists(
        handlerFilePath,
        getHandlerSource({
          projectRelativeDistDir: path.posix.relative(projectDir, distDir),
          prerenderFallbackFalseMap,
          isMiddleware,
          nextConfig: config,
        })
      );

      const operationType =
        output.type === AdapterOutputType.APP_PAGE || AdapterOutputType.PAGES
          ? 'PAGE'
          : 'API';

      const sourceFile = await getSourceFilePathFromPage({
        workPath: projectDir,
        page: output.sourcePage,
        pageExtensions: config.pageExtensions || [],
      });
      const vercelConfigOpts = await getLambdaOptionsFromFunction({
        sourceFile,
        config: vercelConfig,
      });

      await writeIfNotExists(
        path.join(functionDir, `.vc-config.json`),
        JSON.stringify(
          // TODO: strongly type this
          {
            ...vercelConfigOpts,
            filePathMap: files,
            operationType,
            framework: {
              slug: 'nextjs',
              version: nextVersion,
            },
            handler: path.posix.join(
              path.posix.relative(repoRoot, projectDir),
              '___next_launcher.cjs'
            ),
            runtime: nodeVersion.runtime,
            maxDuration: output.config.maxDuration,
            supportsResponseStreaming: true,
            experimentalAllowBundling: true,
            // middleware handler always expects Request/Response interface
            useWebApi: isMiddleware,
            launcherType: 'Nodejs',
          }
        )
      );

      fsSema.release();
    })
  );
}

export async function handlePrerenderOutputs(
  prerenderOutputs: Array<AdapterOutput['PRERENDER']>,
  {
    vercelOutputDir,
    nodeOutputsParentMap,
  }: {
    vercelOutputDir: string;
    nodeOutputsParentMap: Map<string, FuncOutputs[0]>;
  }
) {
  const prerenderParentIds = new Set<string>();
  const fsSema = new Sema(16, { capacity: prerenderOutputs.length });
  const functionsDir = path.join(vercelOutputDir, 'functions');

  await Promise.all(
    prerenderOutputs.map(async (output) => {
      await fsSema.acquire();

      try {
        const prerenderConfigPath = path.join(
          functionsDir,
          `${
            output.pathname === '/' ? '/index' : output.pathname
          }.prerender-config.json`
        );
        const prerenderFallbackPath = output.fallback?.filePath
          ? path.join(
              functionsDir,
              `${
                output.pathname === '/' ? '/index' : output.pathname
              }.prerender-fallback${path.extname(output.fallback.filePath)}`
            )
          : undefined;

        const { parentOutputId } = output;
        prerenderParentIds.add(parentOutputId);

        const parentNodeOutput = nodeOutputsParentMap.get(parentOutputId);

        if (!parentNodeOutput) {
          throw new Error(
            `Invariant: failed to find parent node output ${output.parentOutputId} for prerender output ${output.pathname}`
          );
        }

        const clonedNodeOutput = Object.assign({}, parentNodeOutput);
        clonedNodeOutput.pathname = output.pathname;

        const parentFunctionDir = path.join(
          functionsDir,
          `${
            parentNodeOutput.pathname === '/'
              ? '/index'
              : parentNodeOutput.pathname
          }.func`
        );
        const prerenderFunctionDir = path.join(
          functionsDir,
          `${output.pathname === '/' ? '/index' : output.pathname}.func`
        );

        if (output.pathname !== parentNodeOutput.pathname) {
          await fs.mkdir(path.dirname(prerenderFunctionDir), {
            recursive: true,
          });
          await fs
            .symlink(
              path.relative(
                path.dirname(prerenderFunctionDir),
                parentFunctionDir
              ),
              prerenderFunctionDir
            )
            .catch((err) => {
              // we can tolerate it already existing
              if (!(typeof err === 'object' && err && err.code === 'EEXIST')) {
                throw err;
              }
            });
        }

        const initialHeaders = Object.assign(
          {},
          output.fallback?.initialHeaders
        );

        if (
          output.fallback?.postponedState &&
          output.fallback.filePath &&
          prerenderFallbackPath
        ) {
          const fallbackHtml = await fs.readFile(
            output.fallback.filePath,
            'utf8'
          );
          await writeIfNotExists(
            prerenderFallbackPath,
            `${output.fallback.postponedState}${fallbackHtml}`
          );
          initialHeaders['content-type'] =
            `application/x-nextjs-pre-render; state-length=${output.fallback.postponedState.length}; origin="text/html; charset=utf-8"`;
        }

        await fs.mkdir(path.dirname(prerenderConfigPath), { recursive: true });
        await writeIfNotExists(
          prerenderConfigPath,
          JSON.stringify(
            // TODO: strongly type this
            {
              group: output.groupId,
              expiration:
                typeof output.fallback?.initialRevalidate !== 'undefined'
                  ? output.fallback?.initialRevalidate
                  : 1,

              staleExpiration: output.fallback?.initialExpiration,

              sourcePath: parentNodeOutput?.pathname,

              // send matches in query instead of x-now-route-matches
              // legacy header
              passQuery: true,
              allowQuery: output.config.allowQuery,
              allowHeader: output.config.allowHeader,

              bypassToken: output.config.bypassToken,
              experimentalBypassFor: output.config.bypassFor,

              initialHeaders,
              initialStatus: output.fallback?.initialStatus,

              fallback: prerenderFallbackPath
                ? path.posix.relative(
                    path.dirname(prerenderConfigPath),
                    prerenderFallbackPath
                  )
                : undefined,

              chain: output.pprChain
                ? {
                    ...output.pprChain,
                    outputPath: path.posix.join(parentNodeOutput.pathname),
                  }
                : undefined,
            }
          )
        );

        if (
          output.fallback?.filePath &&
          prerenderFallbackPath &&
          // if postponed state is present we write the fallback file above
          !output.fallback.postponedState
        ) {
          // we use link to avoid copying files un-necessarily
          await copy(output.fallback.filePath, prerenderFallbackPath);
        }
      } catch (err) {
        console.error(`Failed to handle output:`, output);
        throw err;
      }

      fsSema.release();
    })
  );
}

type EdgeFunctionConfig = {
  runtime: 'edge';
  name: string;
  entrypoint: string;
  environment: Record<string, string>;
  filePathMap: Record<string, string>;
  assets?: Array<{ name: string; path: string }>;
  deploymentTarget: string;
  regions?: 'all' | string | string[];
  framework?: { slug: string; version: string };
};

export async function handleEdgeOutputs(
  edgeOutputs: FuncOutputs,
  {
    config,
    distDir,
    repoRoot,
    projectDir,
    nextVersion,
    vercelOutputDir,
  }: {
    distDir: string;
    config: NextConfig;
    repoRoot: string;
    projectDir: string;
    nextVersion: string;
    vercelOutputDir: string;
  }
) {
  const fsSema = new Sema(16, { capacity: edgeOutputs.length });
  const functionsDir = path.join(vercelOutputDir, 'functions');
  const handlerRelativeDir = path.posix.relative(repoRoot, projectDir);

  await Promise.all(
    edgeOutputs.map(async (output) => {
      await fsSema.acquire();

      const functionDir = path.join(
        functionsDir,
        `${output.pathname === '/' ? 'index' : output.pathname}.func`
      );
      await fs.mkdir(functionDir, { recursive: true });

      const files: Record<string, string> = {};
      const jsRegex = /\.(m|c)?js$/;

      const nonJsAssetFiles: Array<{ name: string; path: string }> = [];

      for (const [relPath, fsPath] of Object.entries(output.assets)) {
        if (jsRegex.test(fsPath)) {
          files[relPath] = path.posix.relative(repoRoot, fsPath);
        } else {
          const assetPath = path.posix.join('assets', relPath);

          files[assetPath] = path.posix.relative(repoRoot, fsPath);

          nonJsAssetFiles.push({
            name: relPath,
            path: assetPath,
          });
        }
      }
      for (const [name, fsPath] of Object.entries(output.wasmAssets || {})) {
        files[`wasm/${name}.wasm`] = path.posix.relative(repoRoot, fsPath);
      }
      files[path.posix.relative(projectDir, output.filePath)] =
        path.posix.relative(repoRoot, output.filePath);

      // Get file paths for the edge function source generation

      const filePaths = [
        path.posix.relative(projectDir, output.filePath),
        ...Object.values(output.assets)
          .map((item) => path.posix.relative(projectDir, item))
          .filter((item) => jsRegex.test(item)),
      ];

      // Create Next.js parameters for the edge function
      const params = {
        name: output.id.replace(/\.rsc$/, ''),
        staticRoutes: [],
        dynamicRoutes: [],
        nextConfig: {
          basePath: config.basePath,
          i18n: config.i18n as NonNullable<NextjsParams['nextConfig']>['i18n'],
        },
      };

      // Generate the edge function source using Next.js logic
      const edgeSourceObj = await getNextjsEdgeFunctionSource(
        filePaths,
        params,
        projectDir,
        output.wasmAssets
      );

      const edgeSource = edgeSourceObj.source();

      const handlerFilePath = path.join(
        functionDir,
        handlerRelativeDir,
        'index.js'
      );
      await fs.mkdir(path.dirname(handlerFilePath), { recursive: true });
      await writeIfNotExists(handlerFilePath, edgeSource.toString());

      const edgeConfig: EdgeFunctionConfig = {
        runtime: 'edge',
        name: params.name,
        entrypoint: path.posix.join(
          path.posix.relative(repoRoot, projectDir),
          'index.js'
        ),
        filePathMap: files,
        assets: nonJsAssetFiles,
        deploymentTarget: 'v8-worker',
        environment: output.config.env || {},
        regions: output.config.preferredRegion,
        framework: {
          slug: 'nextjs',
          version: nextVersion,
        },
      };

      await writeIfNotExists(
        path.join(functionDir, '.vc-config.json'),
        JSON.stringify(edgeConfig)
      );

      fsSema.release();
    })
  );
}

export async function handleMiddleware(
  output: AdapterOutput['MIDDLEWARE'],
  ctx: {
    config: NextConfig;
    nextVersion: string;
    distDir: string;
    repoRoot: string;
    projectDir: string;
    vercelOutputDir: string;
    prerenderFallbackFalseMap: Record<string, string[]>;
  }
): Promise<RouteWithSrc[]> {
  if (output.runtime === 'nodejs') {
    await handleNodeOutputs([output], {
      ...ctx,
      isMiddleware: true,
    });
  } else if (output.runtime === 'edge') {
    await handleEdgeOutputs([output], ctx);
  } else {
    throw new Error(`Invalid middleware output ${JSON.stringify(output)}`);
  }

  const routes: RouteWithSrc[] = [];

  for (const matcher of output.config.matchers || []) {
    const route: RouteWithSrc = {
      continue: true,
      has: matcher.has,
      src: matcher.sourceRegex,
      missing: matcher.missing,
    };

    route.middlewarePath = output.pathname;
    route.middlewareRawSrc = matcher.source ? [matcher.source] : [];

    route.override = true;
    routes.push(route);
  }

  return routes;
}

// We only need this once per build
let _usesSrcCache: boolean | undefined;

async function usesSrcDirectory(workPath: string): Promise<boolean> {
  if (!_usesSrcCache) {
    const sourcePages = path.join(workPath, 'src', 'pages');

    try {
      if ((await fs.stat(sourcePages)).isDirectory()) {
        _usesSrcCache = true;
      }
    } catch (_err) {
      _usesSrcCache = false;
    }
  }

  if (!_usesSrcCache) {
    const sourceAppdir = path.join(workPath, 'src', 'app');

    try {
      if ((await fs.stat(sourceAppdir)).isDirectory()) {
        _usesSrcCache = true;
      }
    } catch (_err) {
      _usesSrcCache = false;
    }
  }

  return Boolean(_usesSrcCache);
}

function isDirectory(path: string) {
  return fse.existsSync(path) && fse.lstatSync(path).isDirectory();
}

async function getSourceFilePathFromPage({
  workPath,
  page,
  pageExtensions,
}: {
  workPath: string;
  page: string;
  pageExtensions?: ReadonlyArray<string>;
}) {
  const usesSrcDir = await usesSrcDirectory(workPath);
  const extensionsToTry = pageExtensions || ['js', 'jsx', 'ts', 'tsx'];

  for (const pageType of [
    // middleware is not nested in pages/app
    ...(page === 'middleware' ? [''] : ['pages', 'app']),
  ]) {
    let fsPath = path.join(workPath, pageType, page);
    if (usesSrcDir) {
      fsPath = path.join(workPath, 'src', pageType, page);
    }

    if (fse.existsSync(fsPath)) {
      return path.relative(workPath, fsPath);
    }
    const extensionless = fsPath;

    for (const ext of extensionsToTry) {
      fsPath = `${extensionless}.${ext}`;
      // for appDir, we need to treat "index.js" as root-level "page.js"
      if (
        pageType === 'app' &&
        extensionless ===
          path.join(workPath, `${usesSrcDir ? 'src/' : ''}app/index`)
      ) {
        fsPath = `${extensionless.replace(/index$/, 'page')}.${ext}`;
      }
      if (fse.existsSync(fsPath)) {
        return path.relative(workPath, fsPath);
      }
    }

    if (isDirectory(extensionless)) {
      if (pageType === 'pages') {
        for (const ext of extensionsToTry) {
          fsPath = path.join(extensionless, `index.${ext}`);
          if (fse.existsSync(fsPath)) {
            return path.relative(workPath, fsPath);
          }
        }
        // appDir
      } else {
        for (const ext of extensionsToTry) {
          // RSC
          fsPath = path.join(extensionless, `page.${ext}`);
          if (fse.existsSync(fsPath)) {
            return path.relative(workPath, fsPath);
          }
          // Route Handlers
          fsPath = path.join(extensionless, `route.${ext}`);
          if (fse.existsSync(fsPath)) {
            return path.relative(workPath, fsPath);
          }
        }
      }
    }
  }

  // if we got here, and didn't find a source not-found file, then it was the one injected
  // by Next.js. There's no need to warn or return a source file in this case, as it won't have
  // any configuration applied to it.
  if (page === '/_not-found/page') {
    return '';
  }
  // if we got here, and didn't find a source global-error file, then it was the one injected
  // by Next.js for App Router 500 page. There's no need to warn or return a source file in this case, as it won't have
  // any configuration applied to it.
  if (page === '/_global-error/page') {
    return '';
  }

  // Skip warning for internal pages (_app.js, _error.js, _document.js)
  if (!INTERNAL_PAGES.includes(page)) {
    console.log(
      `WARNING: Unable to find source file for page ${page} with extensions: ${extensionsToTry.join(
        ', '
      )}, this can cause functions config from \`vercel.json\` to not be applied`
    );
  }
  return '';
}
