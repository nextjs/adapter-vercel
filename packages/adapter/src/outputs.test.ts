import path from 'node:path';
import { createFixture } from 'fs-fixture';
import type { AdapterOutput, NextConfig } from 'next';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { describe, expect, it } from 'vitest';
import { handleNodeOutputs } from './outputs';

describe('handleNodeOutputs', () => {
  it('preserves the Next dist package boundary in each node function', async () => {
    const appDir = 'apps/web';
    const nextDistDir = `${appDir}/.next`;
    const functionDir = `${appDir}/.vercel/output/functions/index.func`;

    await using fixture = await createFixture({
      [appDir]: {
        'package.json': '{}',
        'app/page.tsx': 'export default function Page() {}',
        '.next': {
          'package.json': '{"type":"commonjs"}',
          'routes-manifest.json': JSON.stringify({
            headers: [],
            onMatchHeaders: [],
            deploymentId: 'test',
          }),
          'server/app/page.js': 'module.exports = {};',
        },
      },
    });

    const projectDir = fixture.getPath(appDir);
    const distDir = path.join(projectDir, '.next');
    const vercelOutputDir = path.join(projectDir, '.vercel', 'output');
    const routeFilePath = fixture.getPath(`${nextDistDir}/server/app/page.js`);

    const output = {
      type: AdapterOutputType.APP_PAGE,
      id: 'app/index',
      pathname: '/',
      sourcePage: 'index',
      runtime: 'nodejs',
      assets: {},
      filePath: routeFilePath,
      config: {},
    } satisfies AdapterOutput['APP_PAGE'];

    await handleNodeOutputs([output], {
      config: { pageExtensions: ['tsx'] } as NextConfig,
      distDir,
      repoRoot: fixture.path,
      projectDir,
      nextVersion: '16.2.1-canary.34',
      prerenderFallbackFalseMap: {},
      vercelOutputDir,
    });

    const functionPackageJsonPath = `${functionDir}/${nextDistDir}/package.json`;

    await expect(
      fixture.readFile(functionPackageJsonPath, 'utf8')
    ).resolves.toBe('{"type":"commonjs"}');

    const functionConfig = await fixture.readJson<{
      filePathMap: Record<string, string>;
    }>(`${functionDir}/.vc-config.json`);

    expect(functionConfig.filePathMap).toMatchObject({
      'apps/web/.next/package.json': 'apps/web/.next/package.json',
    });
  });
});
