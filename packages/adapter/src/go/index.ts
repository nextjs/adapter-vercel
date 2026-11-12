import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  getLambdaOptionsFromFunction,
  getNodeVersion,
} from '@vercel/build-utils';
import minimatch from 'minimatch';
import type { NextAdapter } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { defaultTracingWasInjected } from '../tracing';
import { getImagesConfig } from '../utils';
import { modifyConfig } from './config';
import { prepareGoFunctions } from './hosted-go';
import { encodeFunctionPattern } from './native-function-patterns';
import { encodeNativeRequest, encodeOutputMaps } from './native-wire';

type PrefetchStage = 'config' | 'complete';
const prefetches = new Map<
  string,
  {
    stage: PrefetchStage;
    promise: Promise<{ durationMs: number; bytes: number }>;
  }
>();

function prefetchBinary(stage: PrefetchStage) {
  const binary =
    process.env.NEXT_ADAPTER_GO_BINARY ||
    path.join(
      __dirname,
      'bin',
      `adapter-vercel-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
    );
  if (process.env.NEXT_ADAPTER_GO_PREFETCH === '0')
    return {
      binary,
      stage,
      promise: Promise.resolve({ durationMs: 0, bytes: 0 }),
    };
  let prefetch = prefetches.get(binary);
  if (!prefetch) {
    const started = performance.now();
    const promise = readFile(binary).then(
      (data) => ({
        durationMs: performance.now() - started,
        bytes: data.byteLength,
      }),
      () => ({ durationMs: performance.now() - started, bytes: 0 })
    );
    prefetch = { stage, promise };
    prefetches.set(binary, prefetch);
    if (process.env.NEXT_NATIVE_BUILD_TIMINGS === '1')
      void promise.then((result) => {
        console.log(
          `[adapter-go-prefetch] ${JSON.stringify({ stage, pid: process.pid, ...result })}`
        );
      });
  }
  return { binary, ...prefetch };
}

function cpuCounters() {
  for (const file of [
    '/sys/fs/cgroup/cpu.stat',
    '/sys/fs/cgroup/cpu/cpu.stat',
  ]) {
    try {
      const counters: Record<string, number> = {};
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
        const [key, value] = line.trim().split(/\s+/);
        if (key && Number.isFinite(Number(value)))
          counters[key] = Number(value);
      }
      return { file, counters };
    } catch {}
  }
}

// Keep JavaScript-specific configuration and module resolution at the hook boundary.
// All output traversal, routing, hashing and filesystem generation runs in the binary.
const adapter: NextAdapter = {
  name: 'Vercel',
  async modifyConfig(config, ctx) {
    // Start the read without blocking configuration or compilation. The full
    // builder timer includes it; onBuildComplete waits only for any remainder.
    if (
      ctx.phase === PHASE_PRODUCTION_BUILD &&
      process.env.NEXT_ADAPTER_GO_PREFETCH_STAGE !== 'complete'
    )
      prefetchBinary('config');
    return modifyConfig(config, ctx);
  },
  async onBuildComplete(ctx) {
    const started = performance.now();
    const timings = process.env.NEXT_NATIVE_BUILD_TIMINGS === '1';
    const cpuBefore = timings ? cpuCounters() : undefined;
    const {
      binary,
      promise: binaryPrefetch,
      stage: prefetchStage,
    } = prefetchBinary('complete');
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
          return {
            pattern,
            regexp: expression.source,
            ...encodeFunctionPattern(pattern),
            options: normalized,
          };
        }
      )
    );
    const goOutputs = ctx.outputs.appRoutes.filter(
      (output) => output.runtime === 'go'
    );
    const goFunctions = await prepareGoFunctions(goOutputs);
    const functions = [
      ...ctx.outputs.appPages,
      ...ctx.outputs.appRoutes,
      ...ctx.outputs.pages,
      ...ctx.outputs.pagesApi,
      ...(ctx.outputs.middleware ? [ctx.outputs.middleware] : []),
    ];
    const wireStarted = performance.now();
    const encodedOutputs = encodeOutputMaps(ctx.outputs);
    const wireMs = performance.now() - wireStarted;
    const request = {
      goFunctions,
      version: 2,
      ...ctx,
      ...encodedOutputs,
      configJSON: JSON.stringify(ctx.config),
      edgeConfigJSON: JSON.stringify({
        basePath: ctx.config.basePath,
        i18n: ctx.config.i18n,
      }),
      images: getImagesConfig(ctx.config),
      nodeRuntime: nodeVersion.runtime,
      disableAutomaticFetchInstrumentation: defaultTracingWasInjected(
        ctx.config
      ),
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
    const prefetchWaitStarted = performance.now();
    const prefetch = await binaryPrefetch;
    const prefetchWaitMs = performance.now() - prefetchWaitStarted;
    let serializationMs = 0;
    let requestBytes: number | undefined;
    let spawnedUnixMs = 0;
    let spawnCallMs = 0;
    let childPid: number | undefined;
    let cpuBeforeSpawn: ReturnType<typeof cpuCounters>;
    await new Promise<void>((resolve, reject) => {
      cpuBeforeSpawn = timings ? cpuCounters() : undefined;
      spawnedUnixMs = Date.now();
      const spawnStarted = performance.now();
      const child = spawn(binary, [], {
        stdio: ['pipe', 'inherit', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        diagnostic = (diagnostic + chunk.toString()).slice(-64 * 1024);
      });
      spawnCallMs = performance.now() - spawnStarted;
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
        else
          reject(
            new Error(
              diagnostic.trim() || `Go adapter failed (${signal || code})`
            )
          );
      });
      child.stdin.once('error', (err) => {
        // The close event reports a binary failure; EPIPE is its consequence.
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
      });
      const serializationStarted = performance.now();
      const payload = encodeNativeRequest(request);
      serializationMs = performance.now() - serializationStarted;
      if (process.env.NEXT_ADAPTER_GO_PROFILE === '1')
        requestBytes = payload.byteLength;
      child.stdin.end(payload);
    });
    if (timings) {
      console.log(
        `[adapter-benchmark] ${JSON.stringify({ implementation: 'go', durationMs: performance.now() - started, preparationMs: prepared - started, wireMs, prefetchMs: prefetch.durationMs, prefetchBytes: prefetch.bytes, prefetchStage, prefetchWaitMs, serializationMs, requestBytes, spawnedUnixMs, spawnCallMs, childPid, cpuBefore, cpuBeforeSpawn, cpuAfter: cpuCounters(), profiled: process.env.NEXT_ADAPTER_GO_PROFILE === '1' })}`
      );
    }
  },
};

// @ts-ignore the package exposes the CommonJS adapter interface.
export = adapter;
