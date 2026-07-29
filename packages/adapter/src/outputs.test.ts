import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterOutput } from 'next';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FuncOutputs } from './outputs';
import { handlePrerenderOutputs } from './outputs';

describe('handlePrerenderOutputs', () => {
  let vercelOutputDir: string;

  beforeEach(async () => {
    vercelOutputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-vercel-test-')
    );
  });

  afterEach(async () => {
    await fs.rm(vercelOutputDir, { recursive: true, force: true });
  });

  function createPrerenderOutput(
    extraFields: Partial<AdapterOutput['PRERENDER']> = {}
  ): AdapterOutput['PRERENDER'] {
    return {
      id: 'prerender-1',
      pathname: '/blog/first',
      type: AdapterOutputType.PRERENDER,
      parentOutputId: 'parent-1',
      groupId: 1,
      route: '/blog/[slug]',
      config: {
        allowQuery: ['slug'],
        allowHeader: ['x-prerender-revalidate'],
      },
      ...extraFields,
    } as AdapterOutput['PRERENDER'];
  }

  async function runAndReadConfig(
    output: AdapterOutput['PRERENDER'],
    parentPathname = '/blog/[slug]'
  ) {
    // The parent output is the function the prerender is served from, which
    // is a different pathname than the prerender itself.
    const nodeOutputsParentMap = new Map<string, FuncOutputs[0]>([
      ['parent-1', { pathname: parentPathname } as FuncOutputs[0]],
    ]);

    await handlePrerenderOutputs([output], {
      config: {},
      vercelOutputDir,
      nodeOutputsParentMap,
      rscContentType: 'text/x-component',
      varyHeader: 'RSC',
    });

    return fs.readFile(
      path.join(
        vercelOutputDir,
        'functions',
        `${output.pathname}.prerender-config.json`
      ),
      'utf8'
    );
  }

  it('writes the classification when routeType, response and compute are all present', async () => {
    const rawConfig = await runAndReadConfig(
      createPrerenderOutput({
        routeType: 'shell',
        response: 'initial',
        compute: 'resuming',
        htmlSize: 0,
      })
    );

    expect(JSON.parse(rawConfig).prerenderClassification).toEqual({
      routeType: 'shell',
      response: 'initial',
      compute: 'resuming',
      htmlSize: 0,
    });
  });

  it('omits htmlSize when the output has no HTML', async () => {
    const rawConfig = await runAndReadConfig(
      createPrerenderOutput({
        routeType: 'route',
        response: 'complete',
        compute: 'static',
      })
    );

    const { prerenderClassification } = JSON.parse(rawConfig);
    expect(prerenderClassification).toEqual({
      routeType: 'route',
      response: 'complete',
      compute: 'static',
    });
    expect('htmlSize' in prerenderClassification).toBe(false);
  });

  it('omits the classification on secondary outputs that carry none', async () => {
    // Sibling RSC and segment-data outputs of a classified group.
    const rawConfig = await runAndReadConfig(createPrerenderOutput());

    expect(JSON.parse(rawConfig).prerenderClassification).toBeUndefined();
  });

  it('omits the classification when it is only partially present', async () => {
    const rawConfig = await runAndReadConfig(
      createPrerenderOutput({
        routeType: 'page',
        // `response` and `compute` are missing, which Next.js treats as an
        // invariant violation — omit the classification rather than emit a
        // half-populated one.
      } as Partial<AdapterOutput['PRERENDER']>)
    );

    expect(JSON.parse(rawConfig).prerenderClassification).toBeUndefined();
  });

  it('writes the source route matcher as sourcePath, not the parent output pathname', async () => {
    // An RSC sibling is served from the `.rsc` parent output, but it belongs
    // to the same source route as the HTML output it accompanies.
    const rawConfig = await runAndReadConfig(
      createPrerenderOutput({
        pathname: '/blog/first.rsc',
        route: '/blog/[slug]',
      }),
      '/blog/[slug].rsc'
    );

    expect(JSON.parse(rawConfig).sourcePath).toBe('/blog/[slug]');
  });
});
