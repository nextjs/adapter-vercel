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
    extraFields: Record<string, unknown> = {}
  ): AdapterOutput['PRERENDER'] {
    return {
      id: 'prerender-1',
      pathname: '/blog/hello',
      type: AdapterOutputType.PRERENDER,
      parentOutputId: 'parent-1',
      groupId: 1,
      config: {
        allowQuery: ['slug'],
        allowHeader: ['x-prerender-revalidate'],
      },
      ...extraFields,
    } as AdapterOutput['PRERENDER'];
  }

  async function runAndReadConfig(output: AdapterOutput['PRERENDER']) {
    const nodeOutputsParentMap = new Map<string, FuncOutputs[0]>([
      ['parent-1', { pathname: '/blog/hello' } as FuncOutputs[0]],
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
        'blog/hello.prerender-config.json'
      ),
      'utf8'
    );
  }

  it('passes prerender classification metadata through without collapsing false/0', async () => {
    const rawConfig = await runAndReadConfig(
      createPrerenderOutput({
        hasPostponed: true,
        hasFallback: false,
        htmlSize: 0,
        isDynamicRoute: true,
      })
    );

    const parsedConfig = JSON.parse(rawConfig);
    expect(parsedConfig.hasPostponed).toBe(true);
    expect(parsedConfig.hasFallback).toBe(false);
    expect(parsedConfig.htmlSize).toBe(0);
    expect(parsedConfig.isDynamicRoute).toBe(true);
  });

  it('omits classification keys when the fields are not provided', async () => {
    const rawConfig = await runAndReadConfig(createPrerenderOutput());

    expect(rawConfig).not.toContain('hasPostponed');
    expect(rawConfig).not.toContain('hasFallback');
    expect(rawConfig).not.toContain('htmlSize');
    expect(rawConfig).not.toContain('isDynamicRoute');
  });
});
