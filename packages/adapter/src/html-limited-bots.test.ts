import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextAdapter } from 'next';
import { HTML_LIMITED_BOT_UA_RE_STRING } from 'next/dist/shared/lib/router/utils/is-bot';
import { afterEach, describe, expect, it } from 'vitest';
import adapter from './index';
import type { VercelConfig } from './types';

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

describe('HTML-limited bot deployment policy', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  async function build(
    nextVersion: string,
    htmlLimitedBots: string | undefined,
    cacheComponents = true
  ): Promise<VercelConfig> {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-html-bots-')
    );
    directories.push(projectDir);
    const distDir = path.join(projectDir, '.next');
    await fs.mkdir(path.join(projectDir, 'public'));
    await fs.mkdir(path.join(distDir, 'output/static/_next/static'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(distDir, 'routes-manifest.json'),
      JSON.stringify({ dynamicRoutes: [], staticRoutes: [] })
    );

    await adapter.onBuildComplete?.({
      projectDir,
      repoRoot: projectDir,
      distDir,
      buildId: 'html-limited-bots',
      nextVersion,
      config: {
        basePath: '',
        cacheComponents,
        htmlLimitedBots,
        experimental: {},
      },
      outputs: {
        appRoutes: [],
        appPages: [],
        pages: [],
        pagesApi: [],
        staticFiles: [],
        prerenders: [],
      },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
        dynamicRoutes: [],
        onMatch: [],
        shouldNormalizeNextData: false,
        rsc: {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          prefetchSegmentDirSuffix: '.segments',
          prefetchSegmentSuffix: '.segment.rsc',
          varyHeader: 'rsc',
          contentTypeHeader: 'text/x-component',
        },
      },
    } as unknown as BuildContext);

    return JSON.parse(
      await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
    );
  }

  it('declares the provisional capability', () => {
    expect(adapter.unstable_capabilities.handlesHtmlLimitedBotPrerenders).toBe(
      true
    );
  });

  describe.each(['16.3.0', '16.5.0-canary.40'])('next@%s', (nextVersion) => {
    it.each([HTML_LIMITED_BOT_UA_RE_STRING, 'MyHTMLLimitedBot|Discordbot'])(
      'emits the configured policy without inspecting prerender markers',
      async (pattern) => {
        const config = await build(nextVersion, pattern);

        expect(config.afterCacheBypass).toEqual([
          {
            name: 'HTML Limited Bots',
            hasAll: [
              {
                type: 'request.header',
                key: 'user-agent',
                value: { re: `.*(?:${pattern}).*` },
              },
              {
                type: 'cache.response.header',
                key: 'x-next-prelude-metadata',
                value: { eq: '0' },
              },
            ],
          },
        ]);
      }
    );
  });

  it('omits the policy without Cache Components', async () => {
    expect(
      (await build('16.5.0-canary.40', 'MyHTMLLimitedBot', false))
        .afterCacheBypass
    ).toBeUndefined();
  });

  it('rejects a Cache Components build without the resolved bot pattern', async () => {
    await expect(build('16.5.0-canary.40', undefined)).rejects.toThrow(
      'Expected the resolved htmlLimitedBots pattern'
    );
  });
});
