import fs from 'node:fs/promises';
import path from 'node:path';
import type { RouteWithSrc } from '@vercel/routing-utils';

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
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const exportedName = entry.exportedName.startsWith('$$RSC_SERVER_ACTION_')
        ? 'anonymous_fn'
        : entry.exportedName;

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
            args: `${entry.filename}#${exportedName}`,
          },
        ],
      });
    }
  }

  return routes;
}
