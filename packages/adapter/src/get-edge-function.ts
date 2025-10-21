/// <reference lib="DOM" />

export interface NextjsParams {
  /**
   * The name of the function exposed in _ENTRIES that will be wrapped.
   */
  name: string;
  /**
   * An array with all static pages that the Next.js application contains.
   * This is required to estimate if a pathname will match a page.
   */
  staticRoutes: { page: string; namedRegex?: string }[];
  /**
   * An array with dynamic page names and their matching regular expression.
   * This is required to estimate if a request will match a dynamic page.
   */
  dynamicRoutes?: { page: string; namedRegex?: string }[];
  /**
   * The Next.js minimal configuration that the Middleware Edge Function
   * requires to parse the URL. This must include the locale config and
   * the basePath.
   */
  nextConfig: NextConfig | null;
}

type EdgeFunction = (
  request: Request,
  context: { waitUntil(promise: Promise<unknown>): void }
) => Promise<Response>;

/**
 * A template to adapt the Next.js Edge Function signature into the core Edge
 * Function signature. This will automatically inject parameters that are
 * missing in default Edge Functions from the provided configuration
 * parameters. Static and Dynamic RegExp are calculated in the module scope
 * to avoid recomputing them for each function invocation.
 */
export default function getNextjsEdgeFunction(
  params: NextjsParams
): EdgeFunction {
  const staticRoutes = params.staticRoutes.map((route) => ({
    regexp: new RegExp(route.namedRegex!),
    page: route.page,
  }));

  const dynamicRoutes =
    params.dynamicRoutes?.map((route) => ({
      regexp: new RegExp(route.namedRegex!),
      page: route.page,
    })) || [];

  return async function edgeFunction(request, context) {
    let pathname = new URL(request.url).pathname;
    let pageMatch: PageMatch = {};

    // Remove the basePath from the URL
    if (params.nextConfig?.basePath) {
      if (pathname.startsWith(params.nextConfig.basePath)) {
        pathname = pathname.replace(params.nextConfig.basePath, '') || '/';
      }
    }

    // Remove the locale from the URL
    if (params.nextConfig?.i18n) {
      for (const locale of params.nextConfig.i18n.locales) {
        const regexp = new RegExp(`^/${locale}($|/)`, 'i');
        if (pathname.match(regexp)) {
          pathname = pathname.replace(regexp, '/') || '/';
          break;
        }
      }
    }

    // Find the page match that will happen if there are no assets matching
    for (const route of staticRoutes) {
      const result = route.regexp.exec(pathname);
      if (result) {
        pageMatch.name = route.page;
        break;
      }
    }

    if (!pageMatch.name) {
      const isApi = isApiRoute(pathname);
      for (const route of dynamicRoutes || []) {
        /**
         * Dynamic API routes should not be checked against dynamic non API
         * routes so we skip it in such case. For example, a request to
         * /api/test should not match /pages/[slug].test having:
         *   - pages/api/foo.js
         *   - pages/[slug]/test.js
         */
        if (isApi && !isApiRoute(route.page)) {
          continue;
        }

        const result = route.regexp.exec(pathname);
        if (result) {
          pageMatch = {
            name: route.page,
            params: result.groups,
          };
          break;
        }
      }
    }

    // Note: withNextRequestContext and toPlainHeaders would need to be implemented
    // For now, we'll use a simplified version that should work with most cases
    const headers: { [header: string]: string | string[] | undefined } = {};
    request.headers.forEach((value, key) => {
      const existing = headers[key];
      if (existing) {
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          headers[key] = [existing, value];
        }
      } else {
        headers[key] = value;
      }
    });

    // Handle set-cookie header specially
    if (headers['set-cookie'] && typeof headers['set-cookie'] === 'string') {
      headers['set-cookie'] = parseSetCookieHeader(headers['set-cookie']);
    }

    // Invoke the function injecting missing parameters
    const result = await (globalThis as any)._ENTRIES[
      `middleware_${params.name}`
    ].default.call(
      {},
      {
        request: {
          url: request.url,
          method: request.method,
          headers,
          ip: header(request.headers, IncomingHeaders.Ip),
          geo: {
            city: header(request.headers, IncomingHeaders.City, true),
            country: header(request.headers, IncomingHeaders.Country, true),
            latitude: header(request.headers, IncomingHeaders.Latitude),
            longitude: header(request.headers, IncomingHeaders.Longitude),
            region: header(request.headers, IncomingHeaders.Region, true),
          },
          nextConfig: params.nextConfig,
          page: pageMatch,
          body: request.body,
        },
      }
    );

    if (result.waitUntil) {
      context.waitUntil(result.waitUntil);
    }

    return result.response;
  };
}

function parseSetCookieHeader(cookieHeader: string): string[] {
  const cookies: string[] = [];
  let current = 0;
  let start: number;
  let char: string;
  let foundCookie: boolean;

  function skipWhitespace(): boolean {
    while (
      current < cookieHeader.length &&
      /\s/.test(cookieHeader.charAt(current))
    ) {
      current += 1;
    }
    return current < cookieHeader.length;
  }

  function isTokenChar(): boolean {
    char = cookieHeader.charAt(current);
    return char !== '=' && char !== ';' && char !== ',';
  }

  while (current < cookieHeader.length) {
    start = current;
    foundCookie = false;

    while (skipWhitespace()) {
      char = cookieHeader.charAt(current);
      if (char === ',') {
        const cookieEnd = current;
        current += 1;
        skipWhitespace();
        const attributeStart = current;

        while (current < cookieHeader.length && isTokenChar()) {
          current += 1;
        }

        if (
          current < cookieHeader.length &&
          cookieHeader.charAt(current) === '='
        ) {
          foundCookie = true;
          current = attributeStart;
          cookies.push(cookieHeader.substring(start, cookieEnd));
          start = current;
        } else {
          current = cookieEnd + 1;
        }
      } else {
        current += 1;
      }
    }

    if (!foundCookie || current >= cookieHeader.length) {
      cookies.push(cookieHeader.substring(start, cookieHeader.length));
    }
  }

  return cookies;
}

/**
 * Allows to get a header value by name but falling back to `undefined` when
 * the value does not exist. Optionally, we can make this function decode
 * what it reads for certain cases.
 *
 * @param headers The Headers object.
 * @param name The name of the header to extract.
 * @param decode Tells if we should decode the value.
 * @returns The header value or undefined.
 */
function header(headers: Headers, name: string, decode = false) {
  const value = headers.get(name) || undefined;
  return decode && value ? decodeURIComponent(value) : value;
}

/**
 * A partial Next.js configuration object that contains the required info
 * to parse the URL and figure out the pathname.
 */
interface NextConfig {
  basePath?: string;
  i18n?: {
    defaultLocale: string;
    domains?: {
      defaultLocale: string;
      domain: string;
      http?: boolean;
      locales?: string[];
    }[];
    localeDetection?: boolean;
    locales: string[];
  };
}

/**
 * Information about the page and parameters that the Middleware Edge
 * Function will match in case it doesn't intercept the request.
 * TODO We must consider if this should be removed as it is misleading.
 */
interface PageMatch {
  name?: string;
  params?: { [key: string]: string };
}

function isApiRoute(path: string) {
  return path === '/api' || path.startsWith('/api/');
}

enum IncomingHeaders {
  /**
   * City of the original client IP calculated by Vercel Proxy.
   */
  City = 'x-vercel-ip-city',
  /**
   * Country of the original client IP calculated by Vercel Proxy.
   */
  Country = 'x-vercel-ip-country',
  /**
   * Ip from Vercel Proxy. Do not confuse it with the client Ip.
   */
  Ip = 'x-real-ip',
  /**
   * Latitude of the original client IP calculated by Vercel Proxy.
   */
  Latitude = 'x-vercel-ip-latitude',
  /**
   * Longitude of the original client IP calculated by Vercel Proxy.
   */
  Longitude = 'x-vercel-ip-longitude',
  /**
   * Region of the original client IP calculated by Vercel Proxy.
   */
  Region = 'x-vercel-ip-country-region',
}
