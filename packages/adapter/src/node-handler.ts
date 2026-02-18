/**
 * NOTE: THIS FILE CANNOT USE IMPORTS OUTSIDE OF THE FUNCTION
 * AS IT NEEDS TO BE STRINGIFIED entirely together
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { NextConfig } from 'next';
import type { RoutesManifest } from 'next/dist/build';

export const getHandlerSource = (ctx: {
  // relative to launcher file
  projectRelativeDistDir: string;
  prerenderFallbackFalseMap: Record<string, string[]>;
  isMiddleware?: boolean;
  nextConfig?: NextConfig;
}) =>
  `
  process.env.NODE_ENV = 'production';
  process.chdir(__dirname);
  
  require('next/setup-node-env')
  
  const _n_handler = (${
    ctx.isMiddleware
      ? () => {
          const path = require('path') as typeof import('path');
          const relativeDistDir = process.env
            .__PRIVATE_RELATIVE_DIST_DIR as string;

          type Context = {
            waitUntil?: (promise: Promise<unknown>) => void;
            headers?: Record<string, string>;
          };

          const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');

          function getRequestContext(): Context {
            const fromSymbol: typeof globalThis & {
              [SYMBOL_FOR_REQ_CONTEXT]?: { get?: () => Context };
            } = globalThis;
            return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
          }

          return async function handler(request: Request): Promise<Response> {
            console.log('middleware handler', request);

            let middlewareHandler = await require(
              './' + path.posix.join(relativeDistDir, 'server', 'middleware.js')
            );
            middlewareHandler = middlewareHandler.handler || middlewareHandler;

            const context = getRequestContext();
            const response = await middlewareHandler(request, {
              waitUntil: context.waitUntil,
              requestMeta: {
                // we use '.' for relative project dir since we process.chdir
                // to the same directory as the handler file so everything is
                // relative to that/project dir
                relativeProjectDir: '.',
              },
            });
            return response;
          };
        }
      : (() => {
          const path = require('path') as typeof import('path');
          const relativeDistDir = process.env
            .__PRIVATE_RELATIVE_DIST_DIR as string;
          const prerenderFallbackFalseMap = process.env
            .__PRIVATE_PRERENDER_FALLBACK_MAP as any as Record<
            string,
            string[]
          >;

          // - we need to process dynamic routes for matching
          // - we need to normalize _next/data, .rsc, segment prefetch to match
          // - we need this handler to be deterministic for all lambdas so it
          // can allow function de-duping
          // - we do not need to handle rewrites as matched-path comes after

          // we use the routes from the manifest as it is filtered to
          // only include the dynamic routes in that specific
          // function after de-duping at infra level
          const {
            dynamicRoutes: dynamicRoutesRaw,
            staticRoutes: staticRoutesRaw,
            i18n,
          } = require(
            './' + path.posix.join(relativeDistDir, 'routes-manifest.json')
          ) as RoutesManifest;

          const matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g;

          function escapeStringRegexp(str: string): string {
            return str.replace(matchOperatorsRegex, '\\$&');
          }

          const dynamicRoutes = dynamicRoutesRaw.map((item) => {
            return {
              ...item,
              namedRegex: new RegExp(item.namedRegex || item.regex),
            };
          });
          const staticRoutes = staticRoutesRaw.map((route) => {
            return {
              ...route,
              namedRegex: new RegExp(
                '^' + escapeStringRegexp(route.page) + '$'
              ),
            };
          });

          // maps un-normalized to normalized app path
          // e.g. /hello/(foo)/page -> /hello
          let appPathRoutesManifest = {} as Record<string, string>;

          try {
            appPathRoutesManifest = require(
              './' +
                path.posix.join(
                  relativeDistDir,
                  'app-path-routes-manifest.json'
                )
            ) as Record<string, string>;
          } catch (_) {}

          const inversedAppRoutesManifest = Object.entries(
            appPathRoutesManifest
          ).reduce(
            (manifest, [originalKey, normalizedKey]) => {
              manifest[normalizedKey] = originalKey;
              return manifest;
            },
            {} as Record<string, string>
          );

          function normalizeLocalePath(
            pathname: string,
            locales?: readonly string[]
          ): {
            pathname: string;
            locale?: string;
          } {
            // If locales is undefined, return the pathname as is.
            if (!locales) return { pathname };

            // Get the cached lowercased locales or create a new cache entry.
            const lowercasedLocales = locales.map((locale) =>
              locale.toLowerCase()
            );

            // The first segment will be empty, because it has a leading `/`. If
            // there is no further segment, there is no locale (or it's the default).
            const segments = pathname.split('/', 2);
            if (!segments[1]) return { pathname };

            // The second segment will contain the locale part if any.
            const segment = segments[1].toLowerCase();

            // See if the segment matches one of the locales. If it doesn't,
            // there is no locale (or it's the default).
            const index = lowercasedLocales.indexOf(segment);
            if (index < 0) return { pathname };

            // Return the case-sensitive locale.
            const detectedLocale = locales[index];
            // Remove the `/${locale}` part of the pathname.
            pathname = pathname.slice(detectedLocale.length + 1) || '/';

            return { pathname, locale: detectedLocale };
          }

          function normalizeDataPath(pathname: string) {
            if (!(pathname || '/').startsWith('/_next/data')) {
              return pathname;
            }
            pathname = pathname
              .replace(/\/_next\/data\/[^/]{1,}/, '')
              .replace(/\.json$/, '');

            if (pathname === '/index') {
              return '/';
            }
            return pathname;
          }

          function matchUrlToPage(urlPathname: string): {
            matchedPathname: string;
            locale?: string;
            matches?: RegExpMatchArray | null;
          } {
            // normalize first
            urlPathname = normalizeDataPath(urlPathname);

            console.log('before normalize', urlPathname);
            for (const suffixRegex of [
              /\.segments(\/.*)\.segment\.rsc$/,
              /\.rsc$/,
            ]) {
              urlPathname = urlPathname.replace(suffixRegex, '');
            }
            const urlPathnameWithLocale = urlPathname;
            const normalizeResult = normalizeLocalePath(
              urlPathname,
              i18n?.locales
            );
            urlPathname = normalizeResult.pathname;
            console.log('after normalize', normalizeResult);

            urlPathname = urlPathname.replace(/\/$/, '') || '/';

            const combinedRoutes = [...staticRoutes, ...dynamicRoutes];

            // attempt matching literal page first
            for (const route of combinedRoutes) {
              if (route.page === urlPathname) {
                console.log('matched direct page', route);
                return {
                  matchedPathname:
                    inversedAppRoutesManifest[route.page] || route.page,
                  locale: normalizeResult.locale,
                };
              }
            }

            // check all routes considering fallback false entries
            for (const route of [...staticRoutes, ...dynamicRoutes]) {
              console.log('testing', route.namedRegex, 'against', urlPathname);
              const matches = urlPathname.match(route.namedRegex);
              if (
                matches ||
                (urlPathname === '/index' && route.namedRegex.test('/'))
              ) {
                const fallbackFalseMap = prerenderFallbackFalseMap[route.page];

                // if this matches a dynamic route that uses fallback: false
                // but the route isn't included we don't consider it match
                // and continue matching
                if (
                  fallbackFalseMap &&
                  !(
                    fallbackFalseMap.includes(urlPathname) ||
                    fallbackFalseMap.includes(urlPathnameWithLocale)
                  )
                ) {
                  console.log('fallback: false but not prerendered', {
                    page: route.page,
                    urlPathname,
                    urlPathnameWithLocale,
                    paths: Object.values(fallbackFalseMap),
                  });
                  continue;
                }

                console.log('matched route', route, urlPathname, matches);
                return {
                  matchedPathname:
                    inversedAppRoutesManifest[route.page] || route.page,
                  locale: normalizeResult.locale,
                  matches,
                };
              }
            }

            // we should have matched above but if not return back
            return {
              matchedPathname:
                inversedAppRoutesManifest[urlPathname] || urlPathname,
              locale: normalizeResult.locale,
            };
          }

          type Context = {
            waitUntil?: (promise: Promise<unknown>) => void;
            headers?: Record<string, string>;
          };

          const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');

          function getRequestContext(): Context {
            const fromSymbol: typeof globalThis & {
              [SYMBOL_FOR_REQ_CONTEXT]?: { get?: () => Context };
            } = globalThis;
            return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
          }

          const RouterServerContextSymbol = Symbol.for(
            '@next/router-server-methods'
          );

          type RouterServerContext = Record<
            string,
            {
              // revalidate function to bypass going through network
              // to invoke revalidate request (uses mocked req/res)
              // function to render the 404 page
              render404?: (
                req: IncomingMessage,
                res: ServerResponse
              ) => Promise<void>;
            }
          >;

          const routerServerGlobal = globalThis as typeof globalThis & {
            [RouterServerContextSymbol]?: RouterServerContext;
          };
          if (!routerServerGlobal[RouterServerContextSymbol]) {
            routerServerGlobal[RouterServerContextSymbol] = {};
          }

          routerServerGlobal[RouterServerContextSymbol]['.'] = {
            async render404(req, res) {
              let mod:
                | undefined
                | {
                    handler: (
                      req: IncomingMessage,
                      res: ServerResponse,
                      ctx: {
                        waitUntil?: (prom: Promise<any>) => void;
                      }
                    ) => Promise<void>;
                  };

              try {
                try {
                  mod = await require(
                    './' +
                      path.posix.join(
                        relativeDistDir,
                        'server',
                        'app',
                        `_not-found`,
                        'page.js'
                      )
                  );
                  console.log('using _not-found.js for render404');
                } catch {}

                if (!mod) {
                  mod = await require(
                    './' +
                      path.posix.join(
                        relativeDistDir,
                        'server',
                        'pages',
                        `404.js`
                      )
                  );
                  console.log('using 404.js for render404');
                }
              } catch (_) {
                mod = await require(
                  './' +
                    path.posix.join(
                      relativeDistDir,
                      'server',
                      'pages',
                      `_error.js`
                    )
                );
                console.log('using _error for render404');
              }
              res.statusCode = 404;

              if (mod) {
                await mod.handler(req, res, {
                  waitUntil: getRequestContext().waitUntil,
                });
              } else {
                console.log(
                  'failed to find 404 module',
                  await require('fs')
                    .promises.readdir(
                      path.posix.join(relativeDistDir, 'server', 'pages')
                    )
                    .catch((err: any) => err)
                );
                res.end('This page could not be found');
              }
            },
          };

          function fixMojibake(input: string): string {
            // Convert each character's char code to a byte
            const bytes = new Uint8Array(input.length);
            for (let i = 0; i < input.length; i++) {
              bytes[i] = input.charCodeAt(i);
            }

            // Decode the bytes as proper UTF-8
            const decoder = new TextDecoder('utf-8');
            return decoder.decode(bytes);
          }

          return async function handler(
            req: import('http').IncomingMessage,
            res: import('http').ServerResponse,
            internalMetadata: any
          ) {
            try {
              const initURL = req.url;
              const parsedUrl = new URL(req.url || '/', 'http://n');
              let urlPathname =
                typeof req.headers['x-matched-path'] === 'string'
                  ? fixMojibake(req.headers['x-matched-path'])
                  : undefined;

              if (typeof urlPathname !== 'string') {
                console.log('no x-matched-path', { url: req.url });
                urlPathname = parsedUrl.pathname || '/';
              }
              const {
                matchedPathname: page,
                locale,
                matches,
              } = matchUrlToPage(urlPathname);
              const isAppDir = page.match(/\/(page|route)$/);
              let addedMatchesToUrl = false;

              // apply missing matches to query if urlPathname is not
              // literal dynamic route. this is mostly to parse params
              // for PPR resume from a rewrite
              for (const matchKey in matches?.groups || {}) {
                const matchValue = matches?.groups?.[matchKey];
                if (!parsedUrl.searchParams.has(matchKey) && matchValue) {
                  parsedUrl.searchParams.set(matchKey, matchValue);
                  addedMatchesToUrl = true;
                }
              }
              if (addedMatchesToUrl) {
                console.log('updating URL with new matches', matches, req.url);
                req.url = `${parsedUrl.pathname}${parsedUrl.searchParams.size > 0 ? '?' : ''}${parsedUrl.searchParams.toString()}`;
              }

              console.log('invoking handler', {
                page,
                url: req.url,
                matchedPath: req.headers['x-matched-path'],
              });

              const mod = await require(
                './' +
                  path.posix.join(
                    relativeDistDir,
                    'server',
                    isAppDir ? 'app' : 'pages',
                    `${page === '/' ? 'index' : page}.js`
                  )
              );

              await mod.handler(req, res, {
                waitUntil: getRequestContext().waitUntil,
                requestMeta: {
                  ...internalMetadata,
                  minimalMode: true,
                  // we use '.' for relative project dir since we process.chdir
                  // to the same directory as the handler file so everything is
                  // relative to that/project dir
                  relativeProjectDir: '.',
                  locale,
                  initURL,
                },
              });
            } catch (error) {
              console.error(`Failed to handle ${req.url}`, error);

              // re-throw the error to allow global handler to decide
              // how to handle
              throw error;
            }
          };
        }).toString()
  })()
  
  module.exports = _n_handler
  
  ${
    ctx.isMiddleware
      ? ''
      : `
    module.exports.getRequestHandlerWithMetadata = (metadata) => {
      console.log('using getRequestHandlerWithMetadata', metadata)
      return (req, res) => _n_handler(req, res, metadata)
    }
  `
  }
  
  `
    .replaceAll(
      'process.env.__PRIVATE_RELATIVE_DIST_DIR',
      `"${ctx.projectRelativeDistDir}"`
    )
    .replaceAll(
      'process.env.__PRIVATE_PRERENDER_FALLBACK_MAP',
      JSON.stringify(ctx.prerenderFallbackFalseMap)
    )
    .replaceAll(
      'process.env.__PRIVATE_NEXT_CONFIG',
      JSON.stringify(ctx.nextConfig)
    );
