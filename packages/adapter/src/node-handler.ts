/**
 * NOTE: THIS FILE CANNOT USE IMPORTS OUTSIDE OF THE FUNCTION
 * AS IT NEEDS TO BE STRINGIFIED entirely together
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { NextConfig } from 'next';

export const getHandlerSource = (ctx: {
  // relative to launcher file
  projectRelativeDistDir: string;
  prerenderFallbackFalseMap: Record<string, string[]>;
  isMiddleware?: boolean;
  nextConfig?: NextConfig;
}) =>
  `
  require('next/dist/server/node-environment');
  require('next/dist/server/node-polyfill-crypto');
  
  try {
    // this can fail to install if styled-jsx is not discoverable
    // but this is tolerable as the require-hook is handling edge cases
    require('next/dist/server/require-hook');
  } catch (_) {}
  
  process.chdir(__dirname);
  
  module.exports = (${
    ctx.isMiddleware
      ? () => {
          const path = require('path') as typeof import('path');
          const relativeDistDir = process.env
            .__PRIVATE_RELATIVE_DIST_DIR as string;

          interface PlainHeaders {
            [header: string]: string | string[] | undefined;
          }

          function toPlainHeaders(headers?: Headers): PlainHeaders {
            const result: PlainHeaders = {};
            if (!headers) return result;
            headers.forEach((value, key) => {
              result[key] = value;
              if (key.toLowerCase() === 'set-cookie') {
                result[key] = splitCookiesString(value);
              }
            });
            return result;
          }

          function splitCookiesString(cookiesString: string) {
            const cookiesStrings: string[] = [];

            let pos = 0;
            let start: number;
            let ch: string;
            let lastComma: number;
            let nextStart: number;
            let cookiesSeparatorFound: boolean;

            function skipWhitespace() {
              while (
                pos < cookiesString.length &&
                /\s/.test(cookiesString.charAt(pos))
              )
                pos += 1;
              return pos < cookiesString.length;
            }

            function notSpecialChar() {
              ch = cookiesString.charAt(pos);
              return ch !== '=' && ch !== ';' && ch !== ',';
            }

            while (pos < cookiesString.length) {
              start = pos;
              cookiesSeparatorFound = false;

              while (skipWhitespace()) {
                ch = cookiesString.charAt(pos);
                if (ch === ',') {
                  // ',' is a cookie separator if we have later first '=', not ';' or ','
                  lastComma = pos;
                  pos += 1;

                  skipWhitespace();
                  nextStart = pos;

                  while (pos < cookiesString.length && notSpecialChar()) {
                    pos += 1;
                  }

                  // currently special character
                  if (
                    pos < cookiesString.length &&
                    cookiesString.charAt(pos) === '='
                  ) {
                    // we found cookies separator
                    cookiesSeparatorFound = true;
                    // pos is inside the next cookie, so back up and return it.
                    pos = nextStart;
                    cookiesStrings.push(
                      cookiesString.substring(start, lastComma)
                    );
                    start = pos;
                  } else {
                    // in param ',' or param separator ';',
                    // we continue from that comma
                    pos = lastComma + 1;
                  }
                } else {
                  pos += 1;
                }
              }

              if (!cookiesSeparatorFound || pos >= cookiesString.length) {
                cookiesStrings.push(
                  cookiesString.substring(start, cookiesString.length)
                );
              }
            }

            return cookiesStrings;
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

          return async function handler(request: Request): Promise<Response> {
            console.log('middleware handler', request);

            function addRequestMeta(
              req: IncomingMessage | Request,
              key: string,
              value: any
            ) {
              const NEXT_REQUEST_META = Symbol.for('NextInternalRequestMeta');
              const meta = (req as any)[NEXT_REQUEST_META] || {};
              meta[key] = value;
              (req as any)[NEXT_REQUEST_META] = meta;
              return meta;
            }
            // we use '.' for relative project dir since we process.chdir
            // to the same directory as the handler file so everything is
            // relative to that/project dir
            addRequestMeta(request, 'relativeProjectDir', '.');

            let middlewareHandler = await require(
              './' + path.posix.join(relativeDistDir, 'server', 'middleware.js')
            );
            middlewareHandler = middlewareHandler.default || middlewareHandler;

            const context = getRequestContext();
            const result = await middlewareHandler({
              request: {
                url: request.url,
                method: request.method,
                headers: toPlainHeaders(request.headers),
                nextConfig: process.env.__PRIVATE_NEXT_CONFIG,
                page: '/middleware',
                body:
                  request.method !== 'GET' && request.method !== 'HEAD'
                    ? request.body
                    : undefined,
                waitUntil: context.waitUntil,
              },
            });

            if (result.waitUntil && context.waitUntil) {
              context.waitUntil(result.waitUntil);
            }

            return result.response;
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
          ) as {
            dynamicRoutes: Array<{
              regex: string;
              page: string;
            }>;
            staticRoutes: Array<{
              regex: string;
              page: string;
            }>;
            i18n?: {
              locales: string[];
            };
          };
          const hydrateRoutesManifestItem = (item: {
            regex: string;
            page: string;
          }) => {
            return {
              ...item,
              regex: new RegExp(item.regex),
            };
          };
          const dynamicRoutes = dynamicRoutesRaw.map(hydrateRoutesManifestItem);
          const staticRoutes = staticRoutesRaw.map(hydrateRoutesManifestItem);

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

          function addRequestMeta(
            req: IncomingMessage,
            key: string,
            value: any
          ) {
            const NEXT_REQUEST_META = Symbol.for('NextInternalRequestMeta');
            const meta = (req as any)[NEXT_REQUEST_META] || {};
            meta[key] = value;
            (req as any)[NEXT_REQUEST_META] = meta;
            return meta;
          }

          function normalizeLocalePath(
            req: IncomingMessage,
            pathname: string,
            locales?: readonly string[]
          ): string {
            // If locales is undefined, return the pathname as is.
            if (!locales) return pathname;

            // Get the cached lowercased locales or create a new cache entry.
            const lowercasedLocales = locales.map((locale) =>
              locale.toLowerCase()
            );

            // The first segment will be empty, because it has a leading `/`. If
            // there is no further segment, there is no locale (or it's the default).
            const segments = pathname.split('/', 2);
            if (!segments[1]) return pathname;

            // The second segment will contain the locale part if any.
            const segment = segments[1].toLowerCase();

            // See if the segment matches one of the locales. If it doesn't,
            // there is no locale (or it's the default).
            const index = lowercasedLocales.indexOf(segment);
            if (index < 0) return pathname;

            // Return the case-sensitive locale.
            const detectedLocale = locales[index];
            // Remove the `/${locale}` part of the pathname.
            pathname = pathname.slice(detectedLocale.length + 1) || '/';

            addRequestMeta(req, 'locale', detectedLocale);

            return pathname;
          }

          function normalizeDataPath(req: IncomingMessage, pathname: string) {
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

          function matchUrlToPage(req: IncomingMessage, urlPathname: string) {
            // normalize first
            urlPathname = normalizeDataPath(req, urlPathname);

            console.log('before normalize', urlPathname);
            for (const suffixRegex of [
              /\.segments(\/.*)\.segment\.rsc$/,
              /\.prefetch\.rsc$/,
              /\.rsc$/,
            ]) {
              urlPathname = urlPathname.replace(suffixRegex, '');
            }
            const urlPathnameWithLocale = urlPathname;
            urlPathname = normalizeLocalePath(req, urlPathname, i18n?.locales);
            console.log('after normalize', urlPathname);

            urlPathname = urlPathname.replace(/\/$/, '') || '/';

            // check all routes considering fallback false entries
            for (const route of [...staticRoutes, ...dynamicRoutes]) {
              if (route.regex.test(urlPathname)) {
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

                console.log('matched route', route, urlPathname);
                return inversedAppRoutesManifest[route.page] || route.page;
              }
            }

            // we should have matched above but if not return back
            return inversedAppRoutesManifest[urlPathname] || urlPathname;
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
                res.end('This page could not be found');
              }
            },
          };

          return async function handler(
            req: import('http').IncomingMessage,
            res: import('http').ServerResponse
          ) {
            try {
              // we use '.' for relative project dir since we process.chdir
              // to the same directory as the handler file so everything is
              // relative to that/project dir
              addRequestMeta(req, 'relativeProjectDir', '.');

              let urlPathname = req.headers['x-matched-path'];

              if (typeof urlPathname !== 'string') {
                console.log('no x-matched-path', { url: req.url });
                const parsedUrl = new URL(req.url || '/', 'http://n');
                urlPathname = parsedUrl.pathname || '/';
              }
              const page = matchUrlToPage(req, urlPathname);
              const isAppDir = page.match(/\/(page|route)$/);

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
              });
            } catch (error) {
              console.error(`Failed to handle ${req.url}`, error);

              // re-throw the error to allow global handler to decide
              // how to handle
              throw error;
            }
          };
        }).toString()
  })()`
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
