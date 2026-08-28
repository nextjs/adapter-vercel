import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerActionMetaRoutes } from './server-actions';

describe('getServerActionMetaRoutes', () => {
  let distDir: string;

  beforeEach(async () => {
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-actions-'));
    await fs.mkdir(path.join(distDir, 'server'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  async function writeManifest(manifest: unknown) {
    await fs.writeFile(
      path.join(distDir, 'server', 'server-reference-manifest.json'),
      JSON.stringify(manifest)
    );
  }

  it('emits a transform route per action for node and edge runtimes', async () => {
    await writeManifest({
      node: {
        '4016ddb08267ddb9285c26b2ae919d07799fdd881d': {
          filename: 'src/lib/actions/auth.ts',
          exportedName: 'loginAction',
        },
      },
      edge: {
        '605fdf7e8a574a26f354ae221ae569fc2a3a6d397b': {
          filename: 'app/actions.ts',
          exportedName: 'submitForm',
        },
      },
      encryptionKey: 'unused',
    });

    expect(await getServerActionMetaRoutes(distDir)).toEqual([
      {
        src: '/(.*)',
        has: [
          {
            type: 'header',
            key: 'next-action',
            value: '4016ddb08267ddb9285c26b2ae919d07799fdd881d',
          },
        ],
        transforms: [
          {
            type: 'request.headers',
            op: 'append',
            target: { key: 'x-server-action-name' },
            args: 'src/lib/actions/auth.ts#loginAction',
          },
        ],
      },
      {
        src: '/(.*)',
        has: [
          {
            type: 'header',
            key: 'next-action',
            value: '605fdf7e8a574a26f354ae221ae569fc2a3a6d397b',
          },
        ],
        transforms: [
          {
            type: 'request.headers',
            op: 'append',
            target: { key: 'x-server-action-name' },
            args: 'app/actions.ts#submitForm',
          },
        ],
      },
    ]);
  });

  it('renames inline anonymous actions and skips incomplete entries', async () => {
    await writeManifest({
      node: {
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
          filename: 'app/page.tsx',
          exportedName: '$$RSC_SERVER_ACTION_0',
        },
        cccccccccccccccccccccccccccccccccccccccccc: {
          filename: 'app/page.tsx',
          exportedName: '$$RSC_SERVER_ACTION_7',
        },
        bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: {
          filename: 'app/other.tsx',
        },
      },
    });

    expect(await getServerActionMetaRoutes(distDir)).toEqual([
      {
        src: '/(.*)',
        has: [
          {
            type: 'header',
            key: 'next-action',
            value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
        transforms: [
          {
            type: 'request.headers',
            op: 'append',
            target: { key: 'x-server-action-name' },
            args: 'app/page.tsx#anonymous_fn',
          },
        ],
      },
      {
        src: '/(.*)',
        has: [
          {
            type: 'header',
            key: 'next-action',
            value: 'cccccccccccccccccccccccccccccccccccccccccc',
          },
        ],
        transforms: [
          {
            type: 'request.headers',
            op: 'append',
            target: { key: 'x-server-action-name' },
            args: 'app/page.tsx#anonymous_fn',
          },
        ],
      },
    ]);
  });

  it('returns no routes when the manifest is missing', async () => {
    expect(await getServerActionMetaRoutes(distDir)).toEqual([]);
  });
});
