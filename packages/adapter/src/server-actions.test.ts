import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getServerActionMetaRoutes,
  trimServerActionMetaRoutesToFit,
} from './server-actions';

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

  it('skips `use cache` function references', async () => {
    await writeManifest({
      node: {
        '805808586004b6f5a8f2e9d1c3b7a2f4e6d8c0b1a3': {
          filename: 'app/data.ts',
          exportedName: '$$RSC_SERVER_CACHE_0',
        },
        '80557034aeaa1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e': {
          filename: 'app/data.ts',
          exportedName: '$$RSC_SERVER_CACHE_getUser',
        },
        '0052d32c76921a2b3c4d5e6f7a8b9c0d1e2f3a4b5c': {
          filename: 'app/actions.ts',
          exportedName: 'loginAction',
        },
      },
    });

    const routes = await getServerActionMetaRoutes(distDir);
    expect(routes.map((route) => route.transforms?.[0]?.args)).toEqual([
      'app/actions.ts#loginAction',
    ]);
  });

  it('returns no routes when the manifest is missing', async () => {
    expect(await getServerActionMetaRoutes(distDir)).toEqual([]);
  });

  it('warns and returns no routes when the manifest is malformed', async () => {
    await fs.writeFile(
      path.join(distDir, 'server', 'server-reference-manifest.json'),
      'not json'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await getServerActionMetaRoutes(distDir)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });

  it('percent-encodes unicode filenames that fail the transform-args charset', async () => {
    await writeManifest({
      node: {
        eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: {
          filename: 'app/acción.js',
          exportedName: 'guardar',
        },
        ffffffffffffffffffffffffffffffffffffffff: {
          filename: 'app/actions.js',
          exportedName: 'ping',
        },
      },
    });

    const routes = await getServerActionMetaRoutes(distDir);
    expect(routes.map((route) => route.transforms?.[0]?.args)).toEqual([
      'app/acci%C3%B3n.js#guardar',
      'app/actions.js#ping',
    ]);
  });

  it('encodes % so a backslash and a literal %5C filename stay distinct', async () => {
    await writeManifest({
      node: {
        '111111111111111111111111111111111111111111': {
          filename: 'app/a\\b.js',
          exportedName: 'one',
        },
        '222222222222222222222222222222222222222222': {
          filename: 'app/a%5Cb.js',
          exportedName: 'two',
        },
      },
    });

    const routes = await getServerActionMetaRoutes(distDir);
    expect(routes.map((route) => route.transforms?.[0]?.args)).toEqual([
      'app/a%5Cb.js#one',
      'app/a%255Cb.js#two',
    ]);
  });

  it('drops action meta routes first when over the CDN route cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const actionRoute = {
      src: '/(.*)',
      transforms: [
        {
          type: 'request.headers',
          op: 'append',
          target: { key: 'x-server-action-name' },
          args: 'app/actions.js#ping',
        },
      ],
    };
    const otherRoute = { src: '/about', dest: '/about' };

    const trimmed = trimServerActionMetaRoutesToFit(
      [otherRoute, actionRoute, actionRoute, actionRoute, otherRoute],
      3
    );

    expect(trimmed).toEqual([otherRoute, actionRoute, otherRoute]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('does not drop non-action routes when they already exceed the cap', () => {
    const other = { src: '/page' };
    const trimmed = trimServerActionMetaRoutesToFit([other, other, other], 2);
    expect(trimmed).toEqual([other, other, other]);
  });

  it('emits a single route for an id present in both node and edge', async () => {
    await writeManifest({
      node: {
        dddddddddddddddddddddddddddddddddddddddddd: {
          filename: 'app/shared.ts',
          exportedName: 'sharedAction',
        },
      },
      edge: {
        dddddddddddddddddddddddddddddddddddddddddd: {
          filename: 'app/shared.ts',
          exportedName: 'sharedAction',
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
            value: 'dddddddddddddddddddddddddddddddddddddddddd',
          },
        ],
        transforms: [
          {
            type: 'request.headers',
            op: 'append',
            target: { key: 'x-server-action-name' },
            args: 'app/shared.ts#sharedAction',
          },
        ],
      },
    ]);
  });
});
