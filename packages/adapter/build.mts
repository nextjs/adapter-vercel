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
  external: ['./node-handler'],
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
