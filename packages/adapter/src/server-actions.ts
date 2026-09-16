import fs from 'node:fs/promises';
import path from 'node:path';
import type { Route, RouteWithSrc } from '@vercel/routing-utils';

type Transform = NonNullable<RouteWithSrc['transforms']>[number];

/**
 * JSON Schema pattern for transform `args` in `@vercel/routing-utils`.
 * Characters outside this set fail API transform-args validation.
 */
const TRANSFORM_ARGS_CHARSET =
  /^[a-zA-Z0-9_ :;.,"'?!(){}[\]@<>=+*#$&`|~^%/-]+$/;

function sanitizeTransformArgs(value: string): string {
  let sanitized = '';
  for (const char of value) {
    // `%` is in the charset, so it must be encoded too — otherwise a
    // backslash (`a\b.js` → `a%5Cb.js`) collides with a file literally
    // named `a%5Cb.js`, and firewall / observability treat them as one action.
    sanitized +=
      char === '%' || !TRANSFORM_ARGS_CHARSET.test(char)
        ? encodeURIComponent(char)
        : char;
  }
  return sanitized;
}

type ActionManifestEntry = {
  filename?: string;
  exportedName?: string;
};

type ActionManifest = {
  node?: Record<string, ActionManifestEntry>;
  edge?: Record<string, ActionManifestEntry>;
};

// Firewall `server_action` rules and observability match on the
// `x-server-action-name` header these routes append per action id.
export const MAX_CDN_ROUTES = 2048;

export function isServerActionMetaRoute(route: Route): boolean {
  return Boolean(
    'transforms' in route &&
      route.transforms?.some(
        (transform: Transform) =>
          transform.target.key === 'x-server-action-name'
      )
  );
}

/**
 * Drop action meta routes first when the table would exceed the API cap.
 * Other routes are left alone so a pre-existing over-limit app still fails
 * the same way it did before adapter-vercel#113.
 */
export function trimServerActionMetaRoutesToFit<T extends Route>(
  routes: T[],
  maxRoutes = MAX_CDN_ROUTES
): T[] {
  if (routes.length <= maxRoutes) {
    return routes;
  }

  const overflow = routes.length - maxRoutes;
  let dropped = 0;
  const trimmed = routes.filter((route) => {
    if (dropped >= overflow) {
      return true;
    }
    if (isServerActionMetaRoute(route)) {
      dropped += 1;
      return false;
    }
    return true;
  });

  if (dropped > 0) {
    console.warn(
      `Dropped ${dropped} server action meta route(s) to stay under the ${maxRoutes} CDN route limit`
    );
  }

  return trimmed;
}

export async function getServerActionMetaRoutes(
  distDir: string
): Promise<RouteWithSrc[]> {
  const manifestPath = path.join(
    distDir,
    'server',
    'server-reference-manifest.json'
  );

  let manifestContent: string;
  try {
    manifestContent = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    // A build without server actions has no manifest.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  let manifest: ActionManifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    console.warn(
      `Failed to parse ${manifestPath}, skipping server action meta routes`
    );
    return [];
  }

  const routes: RouteWithSrc[] = [];
  const seenIds = new Set<string>();

  for (const runtimeType of ['node', 'edge'] as const) {
    const runtime = manifest[runtimeType];
    if (!runtime) continue;

    for (const [id, entry] of Object.entries(runtime)) {
      if (!entry.filename || !entry.exportedName) continue;
      // `use cache` functions are server references too, but are only invoked
      // by the server during rendering, never via a `next-action` header.
      if (entry.exportedName.startsWith('$$RSC_SERVER_CACHE_')) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const exportedName = entry.exportedName.startsWith('$$RSC_SERVER_ACTION_')
        ? 'anonymous_fn'
        : entry.exportedName;

      // Unsanitized `filename#exportedName` fails the API transform-args
      // charset when the path has unicode (or `\`).
      const args = sanitizeTransformArgs(`${entry.filename}#${exportedName}`);
      if (!args || !TRANSFORM_ARGS_CHARSET.test(args)) {
        continue;
      }

      routes.push({
        src: '/(.*)',
        has: [
          {
            type: 'header',
            key: 'next-action',
            value: id,
          },
        ],
        transforms: [
          {
            type: 'request.headers',
            op: 'append',
            target: {
              key: 'x-server-action-name',
            },
            args,
          },
        ],
      });
    }
  }

  return routes;
}
