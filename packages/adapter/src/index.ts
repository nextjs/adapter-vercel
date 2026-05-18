import fs from 'node:fs/promises';
import path from 'node:path';
import type { Route, RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import {
  type FuncOutputs,
  handleEdgeOutputs,
  handleMiddleware,
  handleNodeOutputs,
  handlePrerenderOutputs,
  handlePublicFiles,
  handleStaticOutputs,
} from './outputs';
import {
  denormalizeNextDataRoutes,
  extractHeaders,
  extractOnMatchRoutes,
  extractRedirects,
  modifyWithRewriteHeaders,
  normalizeNextDataRoutes,
  normalizeRewrites,
} from './routing';
import type { VercelConfig } from './types';
import { escapeStringRegexp, getImagesConfig } from './utils';

const myAdapter: NextAdapter = {
  name: 'Vercel',
  modifyConfig(config, ctx) {
    if (
      ctx.phase === PHASE_PRODUCTION_BUILD &&
      process.env.VERCEL_IMMUTABLE_STATIC_FILES_ENABLED === '1'
    ) {
      config.experimental.supportsImmutableAssets = true;
    }

    if (process.env.VERCEL_HASH_SALT != null) {
      config.experimental.outputHashSalt =
        (config.experimental.outputHashSalt ?? '') +
        process.env.VERCEL_HASH_SALT;
    }

    if (
      ctx.phase === PHASE_PRODUCTION_BUILD &&
      process.env.VERCEL_PREVIEW_COMMENTS_ENABLED === '1'
    ) {
      let toolbarScript: string;
      if (process.env.VERCEL_ENV === 'production') {
        toolbarScript = 'production.js';
      } else if (process.env.VERCEL_PREVIEW_COMMENTS_OPT_IN === '1') {
        toolbarScript = 'preview-opt-in.js';
      } else {
        toolbarScript = 'preview.js';
      }

      // @ts-expect-error nextjs not upgraded yet
      config.instrumentationClientInject ??= [];
      // @ts-expect-error nextjs not upgraded yet
      config.instrumentationClientInject.push(
        path.join(__dirname, '../toolbar', toolbarScript)
      );
    }

    return config;
  },
  async onBuildComplete({
    routing,
    config,
    buildId,
    outputs,
    distDir,
    repoRoot,
    projectDir,
    nextVersion,
  }) {
    const vercelOutputDir = path.join(distDir, 'output');
    await fs.mkdir(vercelOutputDir, { recursive: true });

    const escapedBuildId = escapeStringRegexp(buildId);

    const hasMiddleware = Boolean(outputs.middleware);
    const hasAppDir =
      outputs.appPages.length > 0 || outputs.appRoutes.length > 0;

    const hasPagesDir = outputs.pages.length > 0 || outputs.pagesApi.length > 0;
    const shouldHandleMiddlewareDataResolving = routing.shouldNormalizeNextData;

    const i18nConfig = config.i18n;
    const vercelConfig: VercelConfig = {
      version: 3,
      overrides: {},
      wildcard: i18nConfig?.domains
        ? i18nConfig.domains.map((item) => {
            return {
              domain: item.domain,
              value:
                item.defaultLocale === i18nConfig.defaultLocale
                  ? ''
                  : `/${item.defaultLocale}`,
            };
          })
        : undefined,
      images: getImagesConfig(config),
    };

    await handlePublicFiles(
      path.join(projectDir, 'public'),
      vercelOutputDir,
      config
    );
    await handleStaticOutputs(outputs.staticFiles, {
      config,
      vercelConfig,
      vercelOutputDir,
    });

    const nodeOutputsParentMap = new Map<string, FuncOutputs[0]>();
    const edgeOutputs: FuncOutputs = [];
    const nodeOutputs: FuncOutputs = [];

    let hasNotFoundOutput = false;
    let has404Output = false;
    let has500Output = false;

    for (const output of [
      ...outputs.appPages,
      ...outputs.appRoutes,
      ...outputs.pages,
      ...outputs.pagesApi,
      ...outputs.staticFiles,
    ]) {
      if (output.pathname.endsWith('/404')) {
        hasNotFoundOutput = false;
        has404Output = true;
      }
      if (!has404Output && output.pathname.endsWith('/_not-found')) {
        hasNotFoundOutput = true;
      }
      if (output.pathname.endsWith('/500')) {
        has500Output = true;
      }

      if ('runtime' in output) {
        if (output.runtime === 'nodejs') {
          nodeOutputsParentMap.set(output.id, output);
          nodeOutputs.push(output);
        } else if (output.runtime === 'edge') {
          edgeOutputs.push(output);
        }
      }
    }

    for (const output of outputs.staticFiles) {
      if (output.pathname.endsWith('/_not-found')) {
        hasNotFoundOutput = true;
      }
      if (output.pathname.endsWith('/404')) {
        has404Output = true;
      }
      if (output.pathname.endsWith('/500')) {
        has500Output = true;
      }
    }
    const notFoundPath = hasNotFoundOutput
      ? '/_not-found'
      : has404Output
        ? '/404'
        : '/_error';

    // handle edge functions
    await handleEdgeOutputs(edgeOutputs, {
      repoRoot,
      projectDir,
      vercelOutputDir,
      nextVersion,
      config,
    });

    const prerenderFallbackFalseMap: Record<string, string[]> = {};

    for (const prerender of outputs.prerenders) {
      if (
        prerender.parentFallbackMode === false &&
        !prerender.pathname.includes('_next/data') &&
        !prerender.pathname.endsWith('.rsc')
      ) {
        const parentOutput = nodeOutputsParentMap.get(prerender.parentOutputId);

        if (!parentOutput) {
          throw new Error(
            `Invariant: missing parent output ${
              prerender.parentOutputId
            } for prerender ${JSON.stringify(prerender)}`
          );
        }
        const parentPage = parentOutput.pathname.substring(
          config.basePath.length
        );
        let currentMap = prerenderFallbackFalseMap[parentPage];

        if (!currentMap) {
          currentMap = prerenderFallbackFalseMap[parentPage] = [];
        }
        currentMap.push(prerender.pathname.substring(config.basePath.length));
      }
    }

    // handle middleware function
    let middlewareRoutes: RouteWithSrc[] = [];

    if (outputs.middleware) {
      middlewareRoutes = await handleMiddleware(outputs.middleware, {
        config,
        distDir,
        repoRoot,
        projectDir,
        vercelOutputDir,
        nextVersion,
        prerenderFallbackFalseMap,
      });
    }

    // handle node functions
    await handleNodeOutputs(nodeOutputs, {
      config,
      distDir,
      repoRoot,
      projectDir,
      nextVersion,
      vercelOutputDir,
      prerenderFallbackFalseMap,
    });

    // handle prerenders (must come after handle node outputs)
    await handlePrerenderOutputs(outputs.prerenders, {
      config,
      hasAppEntries: outputs.appPages.length > 0,
      varyHeader: routing.rsc.varyHeader,
      vercelOutputDir,
      nodeOutputsParentMap,
      rscContentType: routing.rsc.contentTypeHeader,
    });
    const shouldHandleSegmentPrefetches = outputs.appPages.length > 0;

    // create routes
    const convertedRewrites = normalizeRewrites(routing);

    if (shouldHandleSegmentPrefetches) {
      modifyWithRewriteHeaders(convertedRewrites.beforeFiles, {
        shouldHandleSegmentPrefetches,
      });

      modifyWithRewriteHeaders(convertedRewrites.afterFiles, {
        isAfterFilesRewrite: true,
        shouldHandleSegmentPrefetches,
      });

      modifyWithRewriteHeaders(convertedRewrites.fallback, {
        shouldHandleSegmentPrefetches,
      });
    }

    const { priority: priorityRedirects, normal: redirects } =
      extractRedirects(routing);
    const headers = extractHeaders(routing);
    const onMatchRoutes = extractOnMatchRoutes(routing);

    const dynamicRoutes: RouteWithSrc[] = [];
    let addedNextData404Route = false;

    for (const route of routing.dynamicRoutes) {
      // add route to ensure we 404 for non-existent _next/data
      // routes before trying page dynamic routes
      if (hasPagesDir && !hasMiddleware) {
        if (
          !route.sourceRegex.includes('_next/data') &&
          !addedNextData404Route
        ) {
          addedNextData404Route = true;
          dynamicRoutes.push({
            src: path.posix.join('/', config.basePath || '', '_next/data/(.*)'),
            dest: path.posix.join('/', config.basePath || '', '404'),
            status: 404,
            check: true,
          });
        }
      }

      dynamicRoutes.push({
        src: route.sourceRegex,
        dest: route.destination,
        check: true,
        has: route.has,
        missing: route.missing,
      });
    }

    vercelConfig.routes = [
      /*
        Desired routes order
        - Runtime headers
        - User headers and redirects
        - Runtime redirects
        - Runtime routes
        - Check filesystem, if nothing found continue
        - User rewrites
        - Builder rewrites
      */
      ...priorityRedirects,

      // normalize _next/data URL before processing redirects
      ...normalizeNextDataRoutes(
        config,
        buildId,
        shouldHandleMiddlewareDataResolving,
        true
      ),

      ...(config.i18n
        ? [
            // Handle auto-adding current default locale to path based on
            // $wildcard
            // This is split into two rules to avoid matching the `/index` route as it causes issues with trailing slash redirect
            {
              src: `^${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?!(?:_next/.*|${config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})(?:/.*|$))$`,
              // we aren't able to ensure trailing slash mode here
              // so ensure this comes after the trailing slash redirect
              dest: `${
                config.basePath && config.basePath !== '/'
                  ? path.posix.join('/', config.basePath)
                  : ''
              }$wildcard${config.trailingSlash ? '/' : ''}`,
              continue: true,
            },
            {
              src: `^${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?!(?:_next/.*|${config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})(?:/.*|$))(.*)$`,
              // we aren't able to ensure trailing slash mode here
              // so ensure this comes after the trailing slash redirect
              dest: `${
                config.basePath && config.basePath !== '/'
                  ? path.posix.join('/', config.basePath)
                  : ''
              }$wildcard/$1`,
              continue: true,
            },

            // Handle redirecting to locale specific domains
            ...(config.i18n.domains &&
            config.i18n.domains.length > 0 &&
            config.i18n.localeDetection !== false
              ? [
                  {
                    src: `^${path.posix.join(
                      '/',
                      config.basePath
                    )}/?(?:${config.i18n.locales
                      .map((locale) => escapeStringRegexp(locale))
                      .join('|')})?/?$`,
                    locale: {
                      redirect: config.i18n.domains.reduce(
                        (prev: Record<string, string>, item) => {
                          prev[item.defaultLocale] = `http${
                            item.http ? '' : 's'
                          }://${item.domain}/`;

                          if (item.locales) {
                            item.locales.map((locale) => {
                              prev[locale] = `http${item.http ? '' : 's'}://${
                                item.domain
                              }/${locale}`;
                            });
                          }
                          return prev;
                        },
                        {}
                      ),
                      cookie: 'NEXT_LOCALE',
                    },
                    continue: true,
                  },
                ]
              : []),

            // Handle redirecting to locale paths
            ...(config.i18n.localeDetection !== false
              ? [
                  {
                    // TODO: if default locale is included in this src it won't
                    // be visitable by users who prefer another language since a
                    // cookie isn't set signaling the default locale is
                    // preferred on redirect currently, investigate adding this
                    src: '/',
                    locale: {
                      redirect: config.i18n.locales.reduce(
                        (prev: Record<string, string>, locale) => {
                          prev[locale] =
                            locale === config.i18n?.defaultLocale
                              ? `/`
                              : `/${locale}`;
                          return prev;
                        },
                        {}
                      ),
                      cookie: 'NEXT_LOCALE',
                    },
                    continue: true,
                  },
                ]
              : []),

            // We only want to add these rewrites before user redirects
            // when `skipDefaultLocaleRewrite` is not flagged on
            // and when localeDetection is enabled.

            {
              src: `^${path.posix.join('/', config.basePath)}$`,
              dest: `${path.posix.join(
                '/',
                config.basePath,
                config.i18n.defaultLocale
              )}`,
              continue: true,
            },
            // Auto-prefix non-locale path with default locale
            // note for prerendered pages this will cause
            // x-now-route-matches to contain the path minus the locale
            // e.g. for /de/posts/[slug] x-now-route-matches would have
            // 1=posts%2Fpost-1
            {
              src: `^${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?!(?:_next/.*|${config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})(?:/.*|$))(.*)$`,
              dest: `${path.posix.join(
                '/',
                config.basePath,
                config.i18n.defaultLocale
              )}/$1`,
              continue: true,
            },
          ]
        : []),

      ...headers,

      ...redirects,

      // server actions name meta routes - placeholder for server actions

      // middleware route - placeholder for middleware configuration
      ...middlewareRoutes,

      ...convertedRewrites.beforeFiles,

      // add 404 handling if /404 or locale variants are requested literally
      ...(config.i18n
        ? [
            {
              src: `${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?:${config.i18n.locales
                .map((locale) => locale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|')})?[/]?404/?`,
              status: 404,
              continue: true,
              missing: [
                {
                  type: 'header' as const,
                  key: 'x-prerender-revalidate',
                },
              ],
            },
          ]
        : [
            {
              src: path.posix.join('/', config.basePath, '404/?'),
              status: 404,
              continue: true,
              missing: [
                {
                  type: 'header' as const,
                  key: 'x-prerender-revalidate',
                },
              ],
            },
          ]),

      // add 500 handling if /500 or locale variants are requested literally
      ...(config.i18n
        ? [
            {
              src: `${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?:${config.i18n.locales
                .map((locale) => locale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|')})?[/]?500/?`,
              status: 500,
              continue: true,
            },
          ]
        : [
            {
              src: path.posix.join('/', config.basePath, '500/?'),
              status: 500,
              continue: true,
            },
          ]),

      // denormalize _next/data if middleware + pages
      ...denormalizeNextDataRoutes(
        config,
        buildId,
        shouldHandleMiddlewareDataResolving,
        true
      ),

      // RSC and prefetch request handling for App Router
      ...(hasAppDir
        ? [
            {
              src: path.posix.join(
                '/',
                config.basePath,
                '/(?<path>.+?)(?:/)?$'
              ),
              dest: path.posix.join(
                '/',
                config.basePath,
                `/$path${routing.rsc.prefetchSegmentDirSuffix}/$segmentPath${routing.rsc.prefetchSegmentSuffix}`
              ),
              has: [
                {
                  type: 'header' as const,
                  key: routing.rsc.header,
                  value: '1',
                },
                {
                  type: 'header' as const,
                  key: routing.rsc.prefetchHeader,
                  value: '1',
                },
                {
                  type: 'header' as const,
                  key: routing.rsc.prefetchSegmentHeader,
                  value: '/(?<segmentPath>.+)',
                },
              ],
              continue: true,
              override: true,
            },
            {
              src: path.posix.join('^/', config.basePath, '/?$'),
              dest: path.posix.join(
                '/',
                config.basePath,
                `/index${routing.rsc.prefetchSegmentDirSuffix}/$segmentPath${routing.rsc.prefetchSegmentSuffix}`
              ),
              has: [
                {
                  type: 'header' as const,
                  key: routing.rsc.header,
                  value: '1',
                },
                {
                  type: 'header' as const,
                  key: routing.rsc.prefetchHeader,
                  value: '1',
                },
                {
                  type: 'header' as const,
                  key: routing.rsc.prefetchSegmentHeader,
                  value: '/(?<segmentPath>.+)',
                },
              ],
              continue: true,
              override: true,
            },

            {
              src: `^${path.posix.join('/', config.basePath, '/?')}`,
              has: [
                {
                  type: 'header' as const,
                  key: routing.rsc.header,
                  value: '1',
                },
              ],
              dest: path.posix.join('/', config.basePath, '/index.rsc'),
              headers: {
                vary: routing.rsc.varyHeader,
              },
              continue: true,
              override: true,
            },
            {
              src: `^${path.posix.join(
                '/',
                config.basePath,
                '/((?!.+\\.rsc).+?)(?:/)?$'
              )}`,
              has: [
                {
                  type: 'header' as const,
                  key: routing.rsc.header,
                  value: '1',
                },
              ],
              dest: path.posix.join('/', config.basePath, '/$1.rsc'),
              headers: {
                vary: routing.rsc.varyHeader,
              },
              continue: true,
              override: true,
            },
          ]
        : []),

      { handle: 'filesystem' },

      // ensure the basePath prefixed _next/image is rewritten to the root
      // _next/image path
      ...(config.basePath
        ? [
            {
              src: path.posix.join('/', config.basePath, '_next/image/?'),
              dest: '/_next/image',
              check: true,
            },
          ]
        : []),

      // normalize _next/data if middleware + pages
      ...normalizeNextDataRoutes(
        config,
        buildId,
        shouldHandleMiddlewareDataResolving,
        false
      ),

      ...(!hasMiddleware
        ? [
            // No-op _next/data rewrite to trigger handle: 'rewrites' and then 404
            // if no match to prevent rewriting _next/data unexpectedly
            {
              src: path.posix.join('/', config.basePath, '_next/data/(.*)'),
              dest: path.posix.join('/', config.basePath, '_next/data/$1'),
              check: true,
            },
          ]
        : []),

      // normalize /index.rsc to just / for App Router
      ...(hasAppDir
        ? [
            {
              src: path.posix.join(
                '/',
                config.basePath,
                '/index(\\.action|\\.rsc)'
              ),
              dest: path.posix.join('/', config.basePath),
              continue: true,
            },
          ]
        : []),

      ...convertedRewrites.afterFiles,

      // ensure bad rewrites with /.rsc are fixed for App Router
      ...(hasAppDir
        ? [
            {
              src: path.posix.join('/', config.basePath, '/\\.rsc$'),
              dest: path.posix.join('/', config.basePath, `/index.rsc`),
              check: true,
            },
            {
              src: path.posix.join('/', config.basePath, '(.+)/\\.rsc$'),
              dest: path.posix.join('/', config.basePath, '$1.rsc'),
              check: true,
            },
          ]
        : []),

      { handle: 'resource' },

      ...convertedRewrites.fallback,

      // make sure 404 page is used when a directory is matched without
      // an index page
      { src: path.posix.join('/', config.basePath, '.*'), status: 404 },

      { handle: 'miss' },

      // 404 to plain text file for _next/static
      {
        src: path.posix.join('/', config.basePath, '_next/static/.+'),
        status: 404,
        check: true,
        dest: path.posix.join(
          '/',
          config.basePath,
          '_next/static/not-found.txt'
        ),
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      },

      // if i18n is enabled attempt removing locale prefix to check public files
      // remove locale prefixes to check public files and
      // to allow checking non-prefixed lambda outputs
      ...(config.i18n
        ? [
            // When `skipDefaultLocaleRewrite` is flagged on and localeDetection is disabled,
            // we only want to add the rewrite as the fallback case once routing is complete.
            ...(config.i18n?.localeDetection === false
              ? [
                  {
                    src: `^${path.posix.join('/', config.basePath)}$`,
                    dest: `${path.posix.join(
                      '/',
                      config.basePath,
                      config.i18n.defaultLocale
                    )}`,
                    check: true,
                  },
                  // Auto-prefix non-locale path with default locale
                  // note for prerendered pages this will cause
                  // x-now-route-matches to contain the path minus the locale
                  // e.g. for /de/posts/[slug] x-now-route-matches would have
                  // 1=posts%2Fpost-1
                  {
                    src: `^${path.posix.join(
                      '/',
                      config.basePath,
                      '/'
                    )}(?!(?:_next/.*|${config.i18n.locales
                      .map((locale) => escapeStringRegexp(locale))
                      .join('|')})(?:/.*|$))(.*)$`,
                    dest: `${path.posix.join(
                      '/',
                      config.basePath,
                      config.i18n.defaultLocale
                    )}/$1`,
                    check: true,
                  },
                ]
              : []),
            {
              src: path.posix.join(
                '/',
                config.basePath,
                escapeStringRegexp(config.i18n.defaultLocale)
              ),
              dest: '/',
              check: true,
            },
            {
              src: `^${path.posix.join(
                '/',
                config.basePath
              )}/?(?:${config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})/(.*)`,
              dest: `${path.posix.join('/', config.basePath, '/')}$1`,
              check: true,
            },
          ]
        : []),

      // If it didn't match any of the static routes or dynamic ones, then we
      // should fallback to either prefetch or normal RSC request
      ...(shouldHandleSegmentPrefetches
        ? [
            {
              src: '^/(?<path>.+)(?<rscSuffix>\\.segments/.+\\.segment\\.rsc)(?:/)?$',
              dest: `/$path.rsc`,
              check: true,
            },
          ]
        : []),

      { handle: 'rewrite' },

      // denormalize _next/data if middleware + pages - placeholder
      ...denormalizeNextDataRoutes(
        config,
        buildId,
        shouldHandleMiddlewareDataResolving,
        false
      ),

      // apply _next/data routes (including static ones if middleware + pages)
      // This would require the data routes from the Next.js build manifest

      // apply normal dynamic routes
      ...dynamicRoutes,

      // apply x-nextjs-matched-path header and __next_data_catchall rewrite
      // if middleware + pages - placeholder for middleware handling
      ...(hasMiddleware
        ? [
            {
              src: `^${path.posix.join(
                '/',
                config.basePath,
                '/_next/data/',
                escapedBuildId,
                '/(.*).json'
              )}`,
              headers: {
                'x-nextjs-matched-path': '/$1',
              },
              continue: true,
              override: true,
            },
            // add a catch-all data route so we don't 404 when getting
            // middleware effects
            {
              src: `^${path.posix.join(
                '/',
                config.basePath,
                '/_next/data/',
                escapedBuildId,
                '/(.*).json'
              )}`,
              dest: '__next_data_catchall',
            },
          ]
        : []),

      { handle: 'hit' },

      ...onMatchRoutes,

      // add internal matched path header for function bundle mapping
      {
        src:
          config.basePath && config.basePath !== '/'
            ? path.posix.join('/', config.basePath, '/?(?:index)?(?:/)?$')
            : `/(?:index)?(?:/)?$`,
        headers: {
          'x-matched-path': '/',
        },
        continue: true,
        important: true,
      },
      {
        src: path.posix.join(
          '/',
          config.basePath || '',
          `/((?!index$).*?)(?:/)?$`
        ),
        headers: {
          'x-matched-path': '/$1',
        },
        continue: true,
        important: true,
      },

      { handle: 'error' },

      // Custom Next.js 404 page

      ...(config.i18n
        ? [
            {
              src: `${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?<nextLocale>${config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})(/.*|$)`,
              dest: path.posix.join(
                '/',
                config.basePath,
                '/$nextLocale',
                notFoundPath
              ),
              status: 404,
              caseSensitive: true,
            },
            {
              src: path.posix.join('/', config.basePath, '.*'),
              dest: path.posix.join(
                '/',
                config.basePath,
                `/${config.i18n.defaultLocale}`,
                notFoundPath
              ),
              status: 404,
            },
          ]
        : [
            {
              src: path.posix.join(
                '/',
                config.basePath,
                // if config.basePath is populated we need to
                // add optional handling for trailing slash so
                // that the config.basePath (basePath) itself matches
                `${config.basePath && config.basePath !== '/' ? '?' : ''}.*`
              ),
              dest: path.posix.join('/', config.basePath, notFoundPath),
              status: 404,
            },
          ]),

      // custom 500 page if present
      ...(config.i18n && has500Output
        ? [
            {
              src: `${path.posix.join(
                '/',
                config.basePath,
                '/'
              )}(?<nextLocale>${config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})(/.*|$)`,
              dest: path.posix.join('/', config.basePath, '/$nextLocale/500'),
              status: 500,
              caseSensitive: true,
            },
            {
              src: path.posix.join('/', config.basePath, '.*'),
              dest: path.posix.join(
                '/',
                config.basePath,
                `/${config.i18n.defaultLocale}/500`
              ),
              status: 500,
            },
          ]
        : [
            {
              src: path.posix.join(
                '/',
                config.basePath,
                // if config.basePath is populated we need to
                // add optional handling for trailing slash so
                // that the config.basePath (basePath) itself matches
                `${config.basePath && config.basePath !== '/' ? '?' : ''}.*`
              ),
              dest: path.posix.join(
                '/',
                config.basePath,
                has500Output ? '/500' : '/_error'
              ),
              status: 500,
            },
          ]),
    ] satisfies (RouteWithSrc | Route)[];

    const outputConfigPath = path.join(vercelOutputDir, 'config.json');
    await fs.writeFile(outputConfigPath, JSON.stringify(vercelConfig, null, 2));
  },
};

// @ts-ignore we have to use this for CJS compat
export = myAdapter;
