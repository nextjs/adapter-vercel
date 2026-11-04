import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  getLambdaOptionsFromFunction,
  getNodeVersion,
} from '@vercel/build-utils';
import minimatch from 'minimatch';
import type { NextAdapter } from 'next';
import { modifyConfig } from './config';
import { encodeOutputMaps } from './native-wire';
import { getImagesConfig } from './utils';

// Keep JavaScript-specific configuration and module resolution at the hook boundary.
// All output traversal, routing, hashing and filesystem generation runs in the binary.
const adapter: NextAdapter = {
  name: 'Vercel (Go)',
  modifyConfig,
  async onBuildComplete(ctx) {
    const started = performance.now();
    const projectRequire = createRequire(
      path.join(ctx.projectDir, 'package.json')
    );
    const nextRequire = createRequire(
      projectRequire.resolve('next/package.json')
    );
    const vercelConfig = JSON.parse(
      process.env.NEXT_ADAPTER_VERCEL_CONFIG || '{}'
    );
    const nodeVersion = await getNodeVersion(
      ctx.projectDir,
      undefined,
      vercelConfig,
      {}
    );
    const functionRules = await Promise.all(
      Object.entries(vercelConfig.functions || {}).map(
        async ([pattern, options]) => {
          const expression = minimatch.makeRe(pattern);
          if (!expression)
            throw new Error(`Invalid function pattern: ${pattern}`);
          // Resolve shared platform policy once per rule, rather than once per
          // output. The Go process performs matching and output generation.
          const normalized = await getLambdaOptionsFromFunction({
            sourceFile: pattern,
            config: { ...vercelConfig, functions: { [pattern]: options } },
          });
          return { pattern, regexp: expression.source, options: normalized };
        }
      )
    );
    const functions = [
      ...ctx.outputs.appPages,
      ...ctx.outputs.appRoutes,
      ...ctx.outputs.pages,
      ...ctx.outputs.pagesApi,
      ...(ctx.outputs.middleware ? [ctx.outputs.middleware] : []),
    ];
    const request = {
      version: 2,
      ...ctx,
      ...encodeOutputMaps(ctx.outputs),
      configJSON: JSON.stringify(ctx.config),
      edgeConfigJSON: JSON.stringify({
        basePath: ctx.config.basePath,
        i18n: ctx.config.i18n,
      }),
      images: getImagesConfig(ctx.config),
      nodeRuntime: nodeVersion.runtime,
      nextEnvLoaderPath: nextRequire.resolve('@next/env'),
      templatesDir: path.join(__dirname, 'native-templates'),
      assetOrder: Object.fromEntries(
        functions
          .filter((output) => output.runtime === 'edge')
          .map((output) => [output.id, Object.keys(output.assets)])
      ),
      wasmOrder: Object.fromEntries(
        functions
          .filter((output) => output.runtime === 'edge')
          .map((output) => [
            output.id,
            Object.keys('wasmAssets' in output ? output.wasmAssets || {} : {}),
          ])
      ),
      functionRules,
    };
    const prepared = performance.now();
    let serializationMs = 0;
    let requestBytes: number | undefined;
    let spawnedUnixMs = 0;
    let childPid: number | undefined;
    const binary =
      process.env.NEXT_ADAPTER_GO_BINARY ||
      path.join(
        __dirname,
        'bin',
        `adapter-vercel-${process.platform}-${process.arch}`
      );
    await new Promise<void>((resolve, reject) => {
      spawnedUnixMs = Date.now();
      const child = spawn(binary, [], {
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      childPid = child.pid;
      const cancel = () => child.kill('SIGTERM');
      process.once('SIGTERM', cancel);
      process.once('SIGINT', cancel);
      const cleanup = () => {
        process.removeListener('SIGTERM', cancel);
        process.removeListener('SIGINT', cancel);
      };
      child.once('error', (err) => {
        cleanup();
        reject(err);
      });
      child.once('close', (code, signal) => {
        cleanup();
        if (code === 0) resolve();
        else reject(new Error(`Go adapter failed (${signal || code})`));
      });
      child.stdin.once('error', (err) => {
        // The close event reports a binary failure; EPIPE is its consequence.
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
      });
      const serializationStarted = performance.now();
      const payload = JSON.stringify(request);
      serializationMs = performance.now() - serializationStarted;
      if (process.env.NEXT_ADAPTER_GO_PROFILE === '1')
        requestBytes = Buffer.byteLength(payload);
      child.stdin.end(payload);
    });
    if (process.env.NEXT_NATIVE_BUILD_TIMINGS === '1') {
      console.log(
        `[adapter-benchmark] ${JSON.stringify({ implementation: 'go', durationMs: performance.now() - started, preparationMs: prepared - started, serializationMs, requestBytes, spawnedUnixMs, childPid, profiled: process.env.NEXT_ADAPTER_GO_PROFILE === '1' })}`
      );
    }
  },
};

// @ts-ignore the package exposes the CommonJS adapter interface.
export = adapter;
