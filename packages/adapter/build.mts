import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

await build({
  bundle: true,
  platform: 'node',
  entryPoints: [
    path.join(process.cwd(), 'src/index.ts'),
    path.join(process.cwd(), 'src/native-adapter.ts'),
  ],
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

// Derive build-time templates from the existing runtime code instead of keeping
// a second handler implementation in Go. No JavaScript is evaluated by Go.
const requireFromBuild = createRequire(import.meta.url);
const { getHandlerSource } = requireFromBuild('./dist/node-handler.js');
const templatesDir = path.join(process.cwd(), 'dist/native-templates');
await fs.mkdir(templatesDir, { recursive: true });
for (const isMiddleware of [false, true]) {
  await fs.writeFile(
    path.join(
      templatesDir,
      isMiddleware
        ? 'middleware-handler.template.js'
        : 'node-handler.template.js'
    ),
    getHandlerSource({
      isMiddleware,
      projectRelativeDistDir: '__GO_DIST_DIR__',
      prerenderFallbackFalseMap: '__GO_FALLBACKS__',
      nextConfig: '__GO_CONFIG__',
      nextEnvLoaderPathRelativeToProjectDir: '__GO_ENV_LOADER__',
    })
  );
}
const edge = await build({
  entryPoints: ['src/edge-function-template.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
// This module is a literal runtime template, generated from committed source.
const templateModule = { exports: {} as { template?: string } };
new Function('module', 'exports', edge.outputFiles[0].text)(
  templateModule,
  templateModule.exports
);
if (typeof templateModule.exports.template !== 'string')
  throw new Error('Missing Edge runtime template');
await fs.writeFile(
  path.join(templatesDir, 'edge-function.template.js'),
  templateModule.exports.template
);
await fs.mkdir('dist/bin', { recursive: true });
const targets = new Set([
  ...(['linux', 'darwin'].includes(process.platform)
    ? [`${process.platform}-${process.arch}`]
    : []),
  'linux-x64',
  'linux-arm64',
]);
const regexpModule = execFileSync(
  'go',
  ['list', '-m', '-f', '{{.Dir}}', 'github.com/dlclark/regexp2'],
  { cwd: path.join(process.cwd(), 'native'), encoding: 'utf8' }
).trim();
await fs.mkdir('dist/licenses', { recursive: true });
await fs.copyFile(
  path.join(regexpModule, 'LICENSE'),
  'dist/licenses/regexp2-LICENSE'
);
for (const target of targets) {
  const [platform, arch] = target.split('-');
  execFileSync(
    'go',
    [
      'build',
      '-trimpath',
      '-ldflags=-s -w',
      '-o',
      path.join(process.cwd(), 'dist/bin', `adapter-vercel-${target}`),
      '.',
    ],
    {
      cwd: path.join(process.cwd(), 'native'),
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: platform,
        GOARCH: arch === 'x64' ? 'amd64' : arch,
      },
      stdio: 'inherit',
    }
  );
}
