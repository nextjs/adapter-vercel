import path from 'node:path';
import { AdapterOutputType } from 'next/constants';
import { describe, expect, it } from 'vitest';
import {
  type FuncOutputs,
  getEdgeFunctionFiles,
  getNodeFunctionFiles,
  toPosixPath,
  toPosixRelative,
} from './outputs';

// Windows paths, checked with `path.win32` so these run on any OS. Next.js
// hands the adapter native absolute paths and builds its `assets` keys with
// native `path.relative`, so on Windows both use backslashes.
const win = path.win32;
const repoRoot = 'C:\\Users\\dev\\repo';
const projectDir = 'C:\\Users\\dev\\repo\\apps\\web';

describe('toPosixRelative', () => {
  it('replaces path.posix.relative, which mangles Windows paths', () => {
    const page = 'C:\\Users\\dev\\repo\\.next\\server\\app\\page.js';
    expect(path.posix.relative(repoRoot, page)).toBe(
      '../C:\\Users\\dev\\repo\\.next\\server\\app\\page.js'
    );
    expect(toPosixRelative(repoRoot, page, win)).toBe(
      '.next/server/app/page.js'
    );
  });

  it('walks up out of a monorepo package', () => {
    expect(
      toPosixRelative(
        projectDir,
        'C:\\Users\\dev\\repo\\node_modules\\@next\\env\\dist\\index.js',
        win
      )
    ).toBe('../../node_modules/@next/env/dist/index.js');
    expect(toPosixRelative(repoRoot, repoRoot, win)).toBe('');
  });

  it('rejects a file on another drive instead of writing an absolute path', () => {
    expect(() =>
      toPosixRelative(repoRoot, 'D:\\pnpm-store\\next\\dist\\server.js', win)
    ).toThrow(/different drives/);
  });

  it('leaves POSIX paths as path.posix.relative would', () => {
    for (const [from, to] of [
      ['/repo', '/repo/.next/server/app/page.js'],
      ['/repo/apps/web', '/repo/node_modules/next/dist/server.js'],
      ['/repo', '/repo'],
    ]) {
      expect(toPosixRelative(from, to, path.posix)).toBe(
        path.posix.relative(from, to)
      );
    }
  });
});

describe('toPosixPath', () => {
  it('converts Windows separators only', () => {
    expect(toPosixPath('.next\\server\\app\\page.js', win)).toBe(
      '.next/server/app/page.js'
    );
    expect(toPosixPath('a\\b', path.posix)).toBe('a\\b');
  });
});

const pageOutput = {
  id: '/blog',
  type: AdapterOutputType.PAGES,
  pathname: '/blog',
  sourcePage: '/blog',
  filePath: 'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\pages\\blog.js',
  runtime: 'nodejs',
  assets: {
    'node_modules\\next\\dist\\server\\next-server.js':
      'C:\\Users\\dev\\repo\\node_modules\\next\\dist\\server\\next-server.js',
  },
  assetsHashes: {
    'node_modules\\next\\dist\\server\\next-server.js': 'hash-server',
    'apps\\web\\.next\\server\\pages\\blog.js': 'hash-blog',
  },
  config: {},
} satisfies FuncOutputs[number];

const notFoundOutput = {
  ...pageOutput,
  id: '/404',
  pathname: '/404',
  sourcePage: '/404',
  filePath: 'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\pages\\404.js',
  assets: {
    'apps\\web\\.next\\server\\chunks\\404.js':
      'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\chunks\\404.js',
  },
  assetsHashes: {
    'apps\\web\\.next\\server\\chunks\\404.js': 'hash-404-chunk',
    'apps\\web\\.next\\server\\pages\\404.js': 'hash-404',
  },
} satisfies FuncOutputs[number];

describe('getNodeFunctionFiles with Windows paths', () => {
  it('writes every file map key and value with `/`', () => {
    const before = structuredClone(pageOutput);
    const { files, fileHashes } = getNodeFunctionFiles(pageOutput, {
      notFoundOutput,
      sharedFiles: {
        'apps/web/.next/routes-manifest.json':
          'apps/web/.next/routes-manifest-deterministic.json',
      },
      sharedFileHashes: {
        'apps/web/.next/routes-manifest.json': 'hash-routes',
        'apps/web/___next_launcher.cjs': 'hash-launcher',
      },
      relativeToRepoRoot: (fsPath) => toPosixRelative(repoRoot, fsPath, win),
      pathApi: win,
    });

    expect(files).toEqual({
      'node_modules/next/dist/server/next-server.js':
        'node_modules/next/dist/server/next-server.js',
      'apps/web/.next/server/pages/blog.js':
        'apps/web/.next/server/pages/blog.js',
      'apps/web/.next/server/chunks/404.js':
        'apps/web/.next/server/chunks/404.js',
      'apps/web/.next/server/pages/404.js':
        'apps/web/.next/server/pages/404.js',
      'apps/web/.next/routes-manifest.json':
        'apps/web/.next/routes-manifest-deterministic.json',
    });
    expect(fileHashes).toEqual({
      'node_modules/next/dist/server/next-server.js': 'hash-server',
      'apps/web/.next/server/pages/blog.js': 'hash-blog',
      'apps/web/.next/server/chunks/404.js': 'hash-404-chunk',
      'apps/web/.next/server/pages/404.js': 'hash-404',
      'apps/web/.next/routes-manifest.json': 'hash-routes',
      'apps/web/___next_launcher.cjs': 'hash-launcher',
    });
    // Every key of the file map has a hash, as the CLI expects.
    for (const key of Object.keys(files)) {
      expect(fileHashes, key).toHaveProperty([key]);
    }
    expect(pageOutput).toEqual(before);
  });

  it('only adds the not-found page to Pages Router functions', () => {
    const { files } = getNodeFunctionFiles(
      { ...pageOutput, type: AdapterOutputType.PAGES_API },
      {
        notFoundOutput,
        sharedFiles: {},
        sharedFileHashes: {},
        relativeToRepoRoot: (fsPath) => toPosixRelative(repoRoot, fsPath, win),
        pathApi: win,
      }
    );
    expect(Object.keys(files)).toEqual([
      'node_modules/next/dist/server/next-server.js',
      'apps/web/.next/server/pages/blog.js',
    ]);
  });
});

describe('getEdgeFunctionFiles with Windows paths', () => {
  const edgeOutput = {
    id: '/middleware',
    type: AdapterOutputType.MIDDLEWARE,
    pathname: '/_middleware',
    sourcePage: 'middleware',
    filePath: 'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\middleware.js',
    runtime: 'edge',
    assets: {
      'server\\edge-chunks\\a.js':
        'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\edge-chunks\\a.js',
      'server\\fonts\\inter.ttf':
        'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\fonts\\inter.ttf',
    },
    wasmAssets: {
      wasm_abc: 'C:\\Users\\dev\\repo\\apps\\web\\.next\\server\\abc.wasm',
    },
    config: {},
  } satisfies FuncOutputs[number];

  it('writes the file map, assets and source paths with `/`', () => {
    const result = getEdgeFunctionFiles(edgeOutput, {
      repoRoot,
      projectDir,
      pathApi: win,
    });

    expect(result).toEqual({
      files: {
        'server/edge-chunks/a.js': 'apps/web/.next/server/edge-chunks/a.js',
        'assets/server/fonts/inter.ttf':
          'apps/web/.next/server/fonts/inter.ttf',
        'wasm/wasm_abc.wasm': 'apps/web/.next/server/abc.wasm',
        '.next/server/middleware.js': 'apps/web/.next/server/middleware.js',
      },
      nonJsAssetFiles: [
        {
          name: 'server/fonts/inter.ttf',
          path: 'assets/server/fonts/inter.ttf',
        },
      ],
      sourceFilePaths: [
        '.next/server/edge-chunks/a.js',
        '.next/server/middleware.js',
      ],
    });
  });

  it('fails clearly for an asset on another drive', () => {
    expect(() =>
      getEdgeFunctionFiles(
        {
          ...edgeOutput,
          assets: { 'x.js': 'D:\\shared\\x.js' },
        },
        { repoRoot, projectDir, pathApi: win }
      )
    ).toThrow(/different drives/);
  });
});
