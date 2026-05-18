import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

await build({
  bundle: true,
  platform: 'node',
  entryPoints: [path.join(process.cwd(), 'src/index.ts')],
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
  createRequire(path.join(process.cwd(), '_')).resolve(
    'source-map/lib/mappings.wasm'
  ),
  path.join(process.cwd(), 'dist', 'mappings.wasm')
);

await fs.cp(
  path.join(process.cwd(), 'src/toolbar'),
  path.join(process.cwd(), 'dist/toolbar'),
  { recursive: true }
);
