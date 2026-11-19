import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import type { NextAdapter } from 'next';
import { HTML_LIMITED_BOT_UA_RE_STRING } from 'next/dist/shared/lib/router/utils/is-bot';
import { afterEach, describe, expect, it } from 'vitest';
import adapter from './index';
import type { VercelConfig } from './types';

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];
const execFileAsync = promisify(execFile);
const installedRequire = createRequire(require.resolve('next/package.json'));
const nextDirectory =
  process.env.NEXT_ADAPTER_TEST_NEXT_PATH ??
  path.dirname(require.resolve('next/package.json'));
const nextRequire = createRequire(path.join(nextDirectory, 'package.json'));

const cases = [
  {
    name: 'the normalized default pattern',
    pattern: undefined,
    cacheComponents: true,
  },
  {
    name: 'a custom pattern',
    pattern: 'MyHTMLLimitedBot|Discordbot',
    cacheComponents: true,
  },
  {
    name: 'a pattern at the byte limit',
    pattern: 'x'.repeat(1024),
    cacheComponents: true,
  },
  {
    name: 'an oversized ASCII pattern',
    pattern: 'x'.repeat(1025),
    cacheComponents: true,
  },
  {
    name: 'an oversized UTF-8 pattern',
    pattern: 'é'.repeat(513),
    cacheComponents: true,
  },
  {
    name: 'a build without Cache Components',
    pattern: 'MyHTMLLimitedBot',
    cacheComponents: false,
  },
];

describe('HTML-limited bot builds', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  it.each(cases)(
    'preserves compatible output for $name',
    async ({ pattern, cacheComponents }) => {
      const projectDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'adapter-html-bots-')
      );
      directories.push(projectDir);
      await fs.cp(
        path.join(__dirname, '../test/fixtures/html-limited-bots'),
        projectDir,
        { recursive: true }
      );
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ private: true })
      );
      const modules = path.join(projectDir, 'node_modules');
      await fs.mkdir(path.join(modules, '@vercel'), { recursive: true });
      for (const name of ['next', 'react', 'react-dom']) {
        const directory =
          name === 'next'
            ? nextDirectory
            : path.dirname(installedRequire.resolve(`${name}/package.json`));
        await fs.symlink(directory, path.join(modules, name), 'dir');
      }
      await fs.symlink(
        path.dirname(require.resolve('@vercel/build-utils/package.json')),
        path.join(modules, '@vercel/build-utils'),
        'dir'
      );
      await bundle({
        entryPoints: [path.join(__dirname, 'index.ts')],
        outfile: path.join(projectDir, 'adapter.cjs'),
        platform: 'node',
        bundle: true,
        format: 'cjs',
        external: ['./node-handler', '@vercel/build-utils', 'next', 'next/*'],
      });
      await bundle({
        entryPoints: [path.join(__dirname, 'node-handler.ts')],
        outfile: path.join(projectDir, 'node-handler.js'),
        platform: 'node',
        format: 'cjs',
      });
      await fs.copyFile(
        installedRequire.resolve('source-map/lib/mappings.wasm'),
        path.join(projectDir, 'mappings.wasm')
      );
      await fs.writeFile(
        path.join(projectDir, 'record-adapter.cjs'),
        `
      const fs = require('node:fs');
      const adapterModule = require('./adapter.cjs');
      const adapter = adapterModule.default ?? adapterModule;
      let capabilityCalls = 0;
      module.exports = {
        ...adapter,
        getCapabilities(context) {
          capabilityCalls++;
          return adapter.getCapabilities(context);
        },
        onBuildComplete(context) {
          fs.writeFileSync('build-complete.json', JSON.stringify({ ...context, capabilityCalls }));
          return adapter.onBuildComplete(context);
        },
      };
    `
      );
      await fs.writeFile(
        path.join(projectDir, 'next.config.js'),
        `
      module.exports = {
        cacheComponents: ${cacheComponents},
        env: { TEST_CACHE_COMPONENTS: ${JSON.stringify(String(cacheComponents))} },
        ${pattern === undefined ? '' : `htmlLimitedBots: new RegExp(${JSON.stringify(pattern)}),`}
        adapterPath: require.resolve('./record-adapter.cjs'),
        experimental: { cpus: 2 },
      };
    `
      );
      await execFileAsync(
        process.execPath,
        [nextRequire.resolve('next/dist/bin/next'), 'build', '--webpack'],
        {
          cwd: projectDir,
          env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        }
      ).catch((error) => {
        throw new Error(`${error.stdout}\n${error.stderr}`, { cause: error });
      });

      const context: BuildContext & { capabilityCalls: number } = JSON.parse(
        await fs.readFile(path.join(projectDir, 'build-complete.json'), 'utf8')
      );
      expect(
        context.outputs.appPages.find((output) => output.pathname === '/')?.type
      ).toBe('APP_PAGE');
      const resolvedPattern = pattern ?? HTML_LIMITED_BOT_UA_RE_STRING;
      expect(context.config.htmlLimitedBots).toBe(resolvedPattern);
      const supported = Buffer.byteLength(resolvedPattern, 'utf8') <= 1024;
      expect(adapter.getCapabilities({ config: context.config })).toEqual({
        handlesHtmlLimitedBotPrerenders: supported,
        supportsPrerenderMethodBypass: true,
      });
      const vercelConfig: VercelConfig = JSON.parse(
        await fs.readFile(
          path.join(projectDir, '.next/output/config.json'),
          'utf8'
        )
      );
      if (cacheComponents && supported) {
        expect(vercelConfig.afterCacheBypass).toEqual([
          {
            name: 'HTML Limited Bots',
            hasAll: [
              {
                type: 'request.header',
                key: 'user-agent',
                value: { re: resolvedPattern },
              },
              {
                type: 'cache.response.header',
                key: 'x-next-prelude-metadata',
                value: { eq: '0' },
              },
            ],
          },
        ]);
      } else {
        expect(vercelConfig.afterCacheBypass).toBeUndefined();
      }
      const page = context.outputs.prerenders.find(
        (output) => output.pathname === '/'
      );
      expect(page).toBeDefined();
      if (!page) {
        throw new Error('Expected the App Page prerender');
      }
      const botRule = {
        type: 'header',
        key: 'user-agent',
        value: `.*(?:${resolvedPattern}).*`,
      };
      const actionRules = [
        { type: 'header', key: 'next-action' },
        {
          type: 'header',
          key: 'content-type',
          value: 'multipart/form-data;.*',
        },
      ];
      const rules = [
        ...(context.capabilityCalls
          ? [{ type: 'method', value: 'POST' }]
          : actionRules),
        ...(cacheComponents && !(context.capabilityCalls && supported)
          ? [botRule]
          : []),
      ];
      expect(page.config.bypassFor).toEqual(rules);
      const serialized = JSON.parse(
        await fs.readFile(
          path.join(
            projectDir,
            '.next/output/functions/index.prerender-config.json'
          ),
          'utf8'
        )
      );
      expect(serialized.experimentalBypassFor).toEqual(rules);
      if (
        page.fallback?.initialHeaders?.['x-next-prelude-metadata'] !== undefined
      ) {
        expect(serialized.initialHeaders['x-next-prelude-metadata']).toBe(
          page.fallback.initialHeaders['x-next-prelude-metadata']
        );
      }
      for (const output of context.outputs.prerenders.filter((entry) =>
        entry.pathname.includes('.segments/')
      )) {
        expect(output.config.bypassFor).toBeUndefined();
      }
    },
    150_000
  );
});
