import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

export async function buildNativeAdapter() {
  // Derive build-time templates from the existing runtime code instead of keeping
  // a second handler implementation in Go. No JavaScript is evaluated by Go.
  const requireFromBuild = createRequire(
    path.join(process.cwd(), 'package.json')
  );
  const { getHandlerSource } = requireFromBuild('./dist/node-handler.js');
  const templatesDir = path.join(process.cwd(), 'dist/go/native-templates');
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
        // The runtime derives a separate basePath constant before serializing
        // the full config. Keep both values replaceable in the Go template.
        nextConfig: {
          basePath: '__GO_BASE_PATH__',
          toJSON: () => '__GO_CONFIG__',
        },
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
  await fs.mkdir('dist/go/bin', { recursive: true });
  const targets = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64',
  ];
  // `go list -m` leaves Dir empty when a fresh runner has not downloaded the
  // module. Resolve and download the pinned dependency before copying its license.
  const { Dir: regexpModule } = JSON.parse(
    execFileSync(
      'go',
      ['mod', 'download', '-json', 'github.com/dlclark/regexp2'],
      { cwd: path.join(process.cwd(), 'native'), encoding: 'utf8' }
    )
  );
  if (typeof regexpModule !== 'string' || !regexpModule) {
    throw new Error(
      'Could not resolve the regexp2 module for license packaging'
    );
  }
  await fs.mkdir('dist/go/licenses', { recursive: true });
  await fs.copyFile(
    path.join(regexpModule, 'LICENSE'),
    'dist/go/licenses/regexp2-LICENSE'
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
        path.join(
          process.cwd(),
          'dist/go/bin',
          `adapter-vercel-${target}${platform === 'win32' ? '.exe' : ''}`
        ),
        '.',
      ],
      {
        cwd: path.join(process.cwd(), 'native'),
        env: {
          ...process.env,
          CGO_ENABLED: '0',
          GOOS: platform === 'win32' ? 'windows' : platform,
          GOARCH: arch === 'x64' ? 'amd64' : arch,
        },
        stdio: 'inherit',
      }
    );
  }
}
