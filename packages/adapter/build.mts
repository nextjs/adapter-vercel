import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { buildNativeAdapter } from './native/build.mts';

await fs.rm(path.join(process.cwd(), 'dist'), { recursive: true, force: true });

await build({
  bundle: true,
  platform: 'node',
  entryPoints: {
    typescript: path.join(process.cwd(), 'src/index.ts'),
    'go/index': path.join(process.cwd(), 'src/go/index.ts'),
  },
  // TODO: re-enable after debugging
  minify: false,
  write: true,
  format: 'cjs',
  outdir: path.join(process.cwd(), 'dist'),
  external: ['./node-handler', '@vercel/build-utils'],
});

await build({
  bundle: false,
  platform: 'node',
  entryPoints: [path.join(process.cwd(), 'src/node-handler.ts')],
  minify: false,
  write: true,
  format: 'cjs',
  outdir: path.join(process.cwd(), 'dist'),
});

await fs.copyFile(
  createRequire(path.join(process.cwd(), 'packages/adapter')).resolve(
    'source-map/lib/mappings.wasm'
  ),
  path.join(process.cwd(), 'dist', 'mappings.wasm')
);

await build({
  entryPoints: [path.join(process.cwd(), 'src/entrypoint.ts')],
  platform: 'node',
  format: 'cjs',
  outfile: path.join(process.cwd(), 'dist/index.js'),
});

await buildNativeAdapter();
