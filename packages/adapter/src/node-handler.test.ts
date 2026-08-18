import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHandlerSource } from './node-handler';

describe('node handler route matching', () => {
  let fixtureDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-handler-'));

    await writeModule('node_modules/next/setup-node-env.js', '');
    await writeModule(
      '.next/server/app/api/health/route.js',
      `
        module.exports.handler = async (_req, res) => {
          res.statusCode = 200;
          res.end('health');
        };
      `
    );
    await writeModule(
      '.next/server/app/api/%68literal/route.js',
      `
        module.exports.handler = async (_req, res) => {
          res.statusCode = 200;
          res.end('literal-percent-route');
        };
      `
    );
    await writeModule(
      '.next/server/pages/api/%68ealth.js',
      `throw new Error('unmatched request path was required');`
    );

    await writeJson('.next/routes-manifest.json', {
      dynamicRoutes: [],
      staticRoutes: [route('/api/broken'), route('/api/health')],
    });
    await writeJson('.next/app-path-routes-manifest.json', {
      '/api/%68literal/route': '/api/%68literal',
      '/api/broken/route': '/api/broken',
      '/api/health/route': '/api/health',
    });
    await writeModule(
      '___next_launcher.cjs',
      getHandlerSource({
        projectRelativeDistDir: '.next',
        prerenderFallbackFalseMap: {},
      })
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  function route(page: string) {
    return {
      page,
      regex: `^${page}$`,
      namedRegex: `^${page}$`,
      routeKeys: {},
    };
  }

  async function writeModule(relativePath: string, source: string) {
    const filePath = path.join(fixtureDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, source);
  }

  async function writeJson(relativePath: string, value: unknown) {
    await writeModule(relativePath, JSON.stringify(value));
  }

  function loadHandler() {
    const launcherPath = path.join(fixtureDir, '___next_launcher.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const handler = require(launcherPath);
    process.chdir(originalCwd);
    return handler;
  }

  async function invoke(
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      metadata: Record<string, unknown>
    ) => Promise<void>,
    pathname: string
  ) {
    const req = {
      headers: {
        host: 'localhost',
        'x-matched-path': pathname,
      },
      method: 'GET',
      url: pathname,
    } as IncomingMessage;
    let body = '';
    const res = {
      statusCode: 200,
      end(chunk?: string | Buffer) {
        body += chunk?.toString() || '';
      },
    } as ServerResponse;

    await handler(req, res, {});
    return { status: res.statusCode, body };
  }

  it('returns before requiring an unmatched request path', async () => {
    const handler = loadHandler();

    await expect(invoke(handler, '/api/health')).resolves.toEqual({
      status: 200,
      body: 'health',
    });
    await expect(invoke(handler, '/api/%68ealth')).resolves.toEqual({
      status: 404,
      body: 'This page could not be found',
    });
  });

  it('loads a route backed only by the App paths manifest', async () => {
    const handler = loadHandler();

    await expect(invoke(handler, '/api/%68literal')).resolves.toEqual({
      status: 200,
      body: 'literal-percent-route',
    });
  });

  it('surfaces a missing module for a route that matched', async () => {
    const handler = loadHandler();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(invoke(handler, '/api/broken')).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
    });
    consoleError.mockRestore();
  });
});
