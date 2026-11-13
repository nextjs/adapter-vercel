import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterOutput } from 'next';
import { AdapterOutputType } from 'next/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FuncOutputs,
  handleNodeOutputs,
  handlePrerenderOutputs,
} from './outputs';

describe('handleNodeOutputs automatic fetch instrumentation', () => {
  let projectDir: string;
  let distDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-node-'));
    distDir = path.join(projectDir, '.next');
    await fs.mkdir(distDir);
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ engines: { node: '22.x' } })
    );
    await fs.writeFile(path.join(distDir, 'routes-manifest.json'), '{}');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it.each([
    AdapterOutputType.PAGES,
    AdapterOutputType.APP_ROUTE,
    AdapterOutputType.MIDDLEWARE,
  ] as const)('serializes the current build flag for %s', async (type) => {
    const isMiddleware = type === AdapterOutputType.MIDDLEWARE;
    const output = {
      id: 'node-output',
      type,
      pathname: '/example',
      sourcePage: isMiddleware ? 'middleware' : '/example',
      filePath: path.join(distDir, 'example.js'),
      runtime: 'nodejs',
      assets: {},
      assetsHashes: {},
      config: {},
    } satisfies FuncOutputs[number];

    for (const [value, expected] of [
      ['1', true],
      [undefined, false],
      ['', false],
      ['0', false],
      ['true', false],
      ['1', true],
    ] as const) {
      vi.stubEnv(
        'VERCEL_TRACING_DISABLE_AUTOMATIC_FETCH_INSTRUMENTATION',
        value
      );
      const vercelOutputDir = await fs.mkdtemp(
        path.join(projectDir, 'output-')
      );

      await handleNodeOutputs([output], {
        config: {},
        distDir,
        repoRoot: projectDir,
        projectDir,
        nextVersion: '16.3.0-canary.96',
        isMiddleware,
        prerenderFallbackFalseMap: {},
        vercelOutputDir,
      });

      const config = JSON.parse(
        await fs.readFile(
          path.join(vercelOutputDir, 'functions/example.func/.vc-config.json'),
          'utf8'
        )
      );
      expect(
        config.shouldDisableAutomaticFetchInstrumentation,
        `flag: ${value}`
      ).toBe(expected);
      expect(config.launcherType).toBe('Nodejs');
      expect(config.useWebApi).toBe(isMiddleware);
    }
  });

  it('disables automatic fetch instrumentation when default tracing was injected', async () => {
    vi.stubEnv('VERCEL_TRACING_DISABLE_AUTOMATIC_FETCH_INSTRUMENTATION', '');
    const output = {
      id: 'node-output',
      type: AdapterOutputType.APP_ROUTE,
      pathname: '/example',
      sourcePage: '/example',
      filePath: path.join(distDir, 'example.js'),
      runtime: 'nodejs',
      assets: {},
      assetsHashes: {},
      config: {},
    } satisfies FuncOutputs[number];

    for (const injected of [true, false]) {
      const vercelOutputDir = await fs.mkdtemp(
        path.join(projectDir, 'output-')
      );
      await handleNodeOutputs([output], {
        config: {},
        distDir,
        repoRoot: projectDir,
        projectDir,
        nextVersion: '16.5.0',
        prerenderFallbackFalseMap: {},
        vercelOutputDir,
        disableAutomaticFetchInstrumentation: injected,
      });
      const config = JSON.parse(
        await fs.readFile(
          path.join(vercelOutputDir, 'functions/example.func/.vc-config.json'),
          'utf8'
        )
      );
      expect(config.shouldDisableAutomaticFetchInstrumentation).toBe(injected);
    }
  });
});

const RSC_CONTENT_TYPE = 'text/x-component';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

// React copies the keys of elements enclosing a postponed boundary into the
// postponed state verbatim, so a localized label reaches the state itself. The
// `ä` here stands in for that: it is a single UTF-16 code unit and two UTF-8
// bytes, which is what makes the two ways of measuring the state disagree.
const POSTPONED_STATE =
  '46[["slug",["%%drp%%","d"]]][1,{"nav":"Doppelgänger"}]null';

type PrerenderOutput = Parameters<typeof handlePrerenderOutputs>[0][number];

describe('handlePrerenderOutputs', () => {
  let vercelOutputDir: string;

  beforeEach(async () => {
    vercelOutputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-prerender-')
    );
    // The prerender handler writes its fallback into a functions directory that
    // the node output handler has already created by the time it runs.
    await fs.mkdir(path.join(vercelOutputDir, 'functions'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await fs.rm(vercelOutputDir, { recursive: true, force: true });
  });

  function makePrerenderOutput(
    fallback: AdapterOutput['PRERENDER']['fallback']
  ): PrerenderOutput {
    return {
      id: 'prerender-1',
      pathname: '/blog',
      type: AdapterOutputType.PRERENDER,
      parentOutputId: 'parent-1',
      groupId: 1,
      route: '/blog',
      fallback,
      config: { allowQuery: [] },
    };
  }

  // The parent lookup throws when it misses, and giving the parent the same
  // pathname keeps `handlePrerenderOutputs` from symlinking a function dir it
  // does not need for these assertions.
  const parentOutput: FuncOutputs[0] = {
    id: 'parent-1',
    type: AdapterOutputType.PAGES,
    pathname: '/blog',
    filePath: 'pages/blog.js',
    sourcePage: '/blog',
    runtime: 'nodejs',
    assets: {},
    assetsHashes: {},
    config: {},
  };

  const nodeOutputsParentMap = new Map<string, FuncOutputs[0]>([
    ['parent-1', parentOutput],
  ]);

  async function handlePrerenderOutput(output: PrerenderOutput) {
    await handlePrerenderOutputs([output], {
      config: {},
      vercelOutputDir,
      nodeOutputsParentMap,
      rscContentType: RSC_CONTENT_TYPE,
      varyHeader: 'rsc',
    });

    const functionsDir = path.join(vercelOutputDir, 'functions');
    const config = JSON.parse(
      await fs.readFile(
        path.join(functionsDir, 'blog.prerender-config.json'),
        'utf8'
      )
    );

    const fallbackName = (await fs.readdir(functionsDir)).find((name) =>
      name.startsWith('blog.prerender-fallback')
    );
    expect(
      fallbackName,
      'expected a prerender fallback to be written'
    ).toBeDefined();

    return {
      contentType: config.initialHeaders['content-type'] as string,
      body: await fs.readFile(path.join(functionsDir, fallbackName as string)),
    };
  }

  // Checks the declared length against the bytes that were actually written,
  // and returns whatever the adapter put behind the state. Reading the body at
  // the declared offset keeps this independent of how long the state happens to
  // be, which is what the CDN does with it too.
  function contentAfterDeclaredState(
    contentType: string,
    body: Buffer,
    origin: string
  ) {
    const declared = contentType.match(
      /^application\/x-nextjs-pre-render; state-length=(\d+); origin=(".*")$/
    );
    expect(declared, `unexpected content type: ${contentType}`).not.toBeNull();
    expect(JSON.parse((declared as RegExpMatchArray)[2])).toBe(origin);

    const offset = Number((declared as RegExpMatchArray)[1]);
    const state = body.subarray(0, offset).toString('utf8');

    // Guard against passing for an uninteresting reason: a pure ASCII state
    // cannot tell the two measurements apart.
    expect(state).toBe(POSTPONED_STATE);
    expect(Buffer.byteLength(state)).toBeGreaterThan(state.length);

    return body.subarray(offset).toString('utf8');
  }

  it('declares the state length of a document fallback in bytes', async () => {
    const html = '<!DOCTYPE html><html><body>shell</body></html>';
    const filePath = path.join(vercelOutputDir, 'source.html');
    await fs.writeFile(filePath, html);

    const { contentType, body } = await handlePrerenderOutput(
      makePrerenderOutput({ filePath, postponedState: POSTPONED_STATE })
    );

    expect(
      contentAfterDeclaredState(contentType, body, HTML_CONTENT_TYPE)
    ).toBe(html);
  });

  it('declares the state length of an RSC fallback, which holds no content', async () => {
    const { contentType, body } = await handlePrerenderOutput(
      makePrerenderOutput({
        filePath: undefined,
        postponedState: POSTPONED_STATE,
      })
    );

    // The data route has no prerendered content of its own: its flight rows
    // come from the resume, so the state is the whole body and the declared
    // length has to cover all of it.
    expect(contentAfterDeclaredState(contentType, body, RSC_CONTENT_TYPE)).toBe(
      ''
    );
  });

  async function writtenConfigs(outputs: PrerenderOutput[]) {
    await handlePrerenderOutputs(outputs, {
      config: {},
      vercelOutputDir,
      nodeOutputsParentMap,
      rscContentType: RSC_CONTENT_TYPE,
      varyHeader: 'rsc',
    });

    return Promise.all(
      outputs.map(async (output) =>
        JSON.parse(
          await fs.readFile(
            path.join(
              vercelOutputDir,
              'functions',
              `${output.pathname.slice(1)}.prerender-config.json`
            ),
            'utf8'
          )
        )
      )
    );
  }

  async function writtenConfig(output: PrerenderOutput) {
    const [config] = await writtenConfigs([output]);
    return config;
  }

  describe('initialMetadata', () => {
    it('carries compute and htmlSize verbatim', async () => {
      const config = await writtenConfig({
        ...makePrerenderOutput(undefined),
        // Each classified output supplies its own taxonomy. The adapter carries
        // only `compute` and `htmlSize`.
        routeType: 'page',
        response: 'initial',
        compute: 'resuming',
        // Zero is a real shell size — a shell that postponed everything —
        // and must survive a presence test rather than a truthiness test.
        htmlSize: 0,
      });

      expect(config.initialMetadata).toEqual({
        compute: 'resuming',
        htmlSize: 0,
      });
      // The rest of the taxonomy is deliberately not forwarded.
      expect(config).not.toHaveProperty('routeType');
      expect(config).not.toHaveProperty('response');
      expect(config).not.toHaveProperty('htmlSize');
    });

    it('omits htmlSize when the output has no HTML shell', async () => {
      // Route handlers are classified but have no HTML shell to measure.
      const config = await writtenConfig({
        ...makePrerenderOutput(undefined),
        routeType: 'route',
        response: 'complete',
        compute: 'static',
      });

      expect(config.initialMetadata).toEqual({ compute: 'static' });
      expect(config.initialMetadata).not.toHaveProperty('htmlSize');
    });

    it('omits initialMetadata when Next.js supplied no compute', async () => {
      // Unclassified outputs and builds from older Next.js versions must not
      // gain an empty metadata object.
      const config = await writtenConfig(makePrerenderOutput(undefined));

      expect(config).not.toHaveProperty('initialMetadata');
    });
  });

  describe('onMiss', () => {
    it.each([
      {
        name: 'complete static output',
        response: 'complete',
        compute: 'static',
        onMiss: 'sync',
      },
      {
        name: 'HTML with client-only pending UI',
        response: 'initial',
        compute: 'static',
        onMiss: 'sync',
      },
      {
        name: 'static navigation without a fallback',
        response: 'empty',
        compute: 'static',
        onMiss: 'sync',
      },
      {
        name: 'explicitly blocking parameter matching',
        response: 'empty',
        compute: 'blocking',
        onMiss: 'sync',
      },
      {
        name: 'partial HTML with server continuation',
        response: 'initial',
        compute: 'resuming',
        onMiss: 'dynamic',
      },
      {
        name: 'request-time rendering without initial content',
        response: 'empty',
        compute: 'dynamic',
        onMiss: 'dynamic',
      },
    ] as const)(
      'emits $onMiss for $name',
      async ({ response, compute, onMiss }) => {
        const config = await writtenConfig({
          ...makePrerenderOutput(undefined),
          routeType: 'page',
          response,
          compute,
        });

        expect(config.onMiss).toBe(onMiss);
      }
    );

    it('derives independent HTML and full-route RSC policies within a group', async () => {
      const [htmlConfig, rscConfig] = await writtenConfigs([
        {
          ...makePrerenderOutput(undefined),
          routeType: 'shell',
          response: 'complete',
          compute: 'static',
          htmlSize: 128,
        },
        {
          ...makePrerenderOutput(undefined),
          id: 'prerender-2',
          pathname: '/blog.rsc',
          routeType: 'shell',
          response: 'empty',
          compute: 'dynamic',
        },
      ]);

      expect(htmlConfig.onMiss).toBe('sync');
      expect(htmlConfig.initialMetadata).toEqual({
        compute: 'static',
        htmlSize: 128,
      });
      expect(rscConfig.onMiss).toBe('dynamic');
      expect(rscConfig.initialMetadata).toEqual({ compute: 'dynamic' });
    });

    it.each([
      '/blog',
      '/blog.rsc',
      '/blog.segments/_full.segment.rsc',
      '/blog.json',
    ])('omits onMiss for unclassified output %s', async (pathname) => {
      const config = await writtenConfig({
        ...makePrerenderOutput(undefined),
        pathname,
      });

      expect(config).not.toHaveProperty('onMiss');
    });

    it('omits onMiss for Route Handler outputs', async () => {
      const config = await writtenConfig({
        ...makePrerenderOutput(undefined),
        routeType: 'route',
        response: 'complete',
        compute: 'static',
      });

      expect(config).not.toHaveProperty('onMiss');
      expect(config.initialMetadata).toEqual({ compute: 'static' });
    });
  });
});
