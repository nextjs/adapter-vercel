import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import { getHandlerSource } from '../src/node-handler';

const require = createRequire(import.meta.url);
const REQUEST_CONTEXT_SYMBOL = Symbol.for('@vercel/request-context');
const ROUTE_MODULE_SYMBOL = Symbol.for('adapter-vercel-test-route-module');
const symbolGlobals = globalThis as typeof globalThis & Record<symbol, unknown>;

type TestRequest = ReturnType<typeof createRequest>;
type Launcher = (
  req: TestRequest,
  res: Record<string, never>,
  internalMetadata: Record<string, unknown>
) => Promise<void>;

function restoreGlobal(symbol: symbol, previousValue: unknown) {
  if (previousValue === undefined) {
    delete symbolGlobals[symbol];
  } else {
    symbolGlobals[symbol] = previousValue;
  }
}

function createRequest() {
  return {
    method: 'GET',
    url: '/rewritten/alpha?existing=1',
    headers: {
      host: 'example.com',
      'x-matched-path': '/fr/rooms/alpha',
    },
  };
}

async function withGeneratedLauncher(
  {
    requestContext,
    routeModule,
  }: {
    requestContext: Record<string, unknown>;
    routeModule: Record<string, unknown>;
  },
  run: (launcher: Launcher) => Promise<void>
) {
  const fixtureDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'adapter-vercel-node-handler-')
  );
  const nextDir = path.join(fixtureDir, '.next');
  const routeDir = path.join(nextDir, 'server', 'app', 'rooms', '[room]');
  const nextModuleDir = path.join(fixtureDir, 'node_modules', 'next');
  const launcherPath = path.join(fixtureDir, 'launcher.cjs');
  const previousCwd = process.cwd();
  const previousRequestContext = symbolGlobals[REQUEST_CONTEXT_SYMBOL];
  const previousRouteModule = symbolGlobals[ROUTE_MODULE_SYMBOL];

  fs.mkdirSync(routeDir, { recursive: true });
  fs.mkdirSync(nextModuleDir, { recursive: true });
  fs.writeFileSync(path.join(nextModuleDir, 'setup-node-env.js'), '');
  fs.writeFileSync(
    path.join(nextDir, 'routes-manifest.json'),
    JSON.stringify({
      dynamicRoutes: [
        {
          page: '/rooms/[room]',
          regex: '^/rooms/([^/]+?)(?:/)?$',
          namedRegex: '^/rooms/(?<room>[^/]+?)(?:/)?$',
        },
      ],
      staticRoutes: [],
      i18n: {
        defaultLocale: 'en',
        locales: ['en', 'fr'],
      },
    })
  );
  fs.writeFileSync(
    path.join(nextDir, 'app-path-routes-manifest.json'),
    JSON.stringify({ '/rooms/[room]/route': '/rooms/[room]' })
  );
  fs.writeFileSync(
    path.join(routeDir, 'route.js'),
    "module.exports = globalThis[Symbol.for('adapter-vercel-test-route-module')];\n"
  );
  fs.writeFileSync(
    launcherPath,
    getHandlerSource({
      projectRelativeDistDir: '.next',
      prerenderFallbackFalseMap: {},
      nextConfig: {},
    })
  );

  symbolGlobals[REQUEST_CONTEXT_SYMBOL] = {
    get: () => requestContext,
  };
  symbolGlobals[ROUTE_MODULE_SYMBOL] = routeModule;

  try {
    const launcher = require(launcherPath) as Launcher;
    await run(launcher);
  } finally {
    process.chdir(previousCwd);
    restoreGlobal(REQUEST_CONTEXT_SYMBOL, previousRequestContext);
    restoreGlobal(ROUTE_MODULE_SYMBOL, previousRouteModule);

    for (const loadedPath of Object.keys(require.cache)) {
      if (loadedPath.startsWith(`${fixtureDir}${path.sep}`)) {
        delete require.cache[loadedPath];
      }
    }

    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test('uses the HTTP handler when no upgrade accessor is available', async () => {
  const handler = vi.fn(async () => {});
  const upgradeHandler = vi.fn(async () => {});

  await withGeneratedLauncher(
    {
      requestContext: {},
      routeModule: { handler, upgradeHandler },
    },
    async (launcher) => {
      await launcher(createRequest(), {}, { requestId: 'no-accessor' });
    }
  );

  expect(handler).toHaveBeenCalledOnce();
  expect(upgradeHandler).not.toHaveBeenCalled();
});

test('does not consume the upgrade accessor for modules without upgradeHandler', async () => {
  const handler = vi.fn(async () => {});
  const upgradeWebSocket = vi.fn(() => undefined);

  await withGeneratedLauncher(
    {
      requestContext: { upgradeWebSocket },
      routeModule: { handler },
    },
    async (launcher) => {
      await launcher(createRequest(), {}, { requestId: 'http-only' });
    }
  );

  expect(upgradeWebSocket).not.toHaveBeenCalled();
  expect(handler).toHaveBeenCalledOnce();
});

test('dispatches raw upgrade primitives and handler context exactly once', async () => {
  const waitUntil = () => {};
  const rawRequest = {
    method: 'GET',
    url: '/rewritten/alpha?existing=1',
    headers: { host: 'example.com' },
  };
  const socket = new PassThrough();
  const head = Buffer.from('upgrade-head');
  const syntheticRequest = createRequest();
  const handler = vi.fn(async () => {});
  const upgradeWebSocket = vi.fn(() => ({ req: rawRequest, socket, head }));
  const upgradeHandler = vi.fn(async (context, transport) => {
    expect(context.waitUntil).toBe(waitUntil);
    expect(context).not.toHaveProperty('responseHeaders');
    expect(context.requestMeta).toEqual({
      requestId: 'upgrade',
      internalValue: 42,
      minimalMode: true,
      relativeProjectDir: '.',
      locale: 'fr',
      initURL: 'https://example.com/rewritten/alpha?existing=1',
    });
    expect(transport.node.req).toBe(rawRequest);
    expect(transport.node.socket).toBe(socket);
    expect(transport.node.head).toBe(head);
    expect(transport.node.req.url).toBe(
      '/rewritten/alpha?existing=1&room=alpha'
    );
  });

  try {
    await withGeneratedLauncher(
      {
        requestContext: {
          waitUntil,
          headers: { 'x-platform-header': 'incoming' },
          upgradeWebSocket,
        },
        routeModule: { handler, upgradeHandler },
      },
      async (launcher) => {
        await launcher(
          syntheticRequest,
          {},
          {
            requestId: 'upgrade',
            internalValue: 42,
          }
        );
      }
    );
  } finally {
    socket.destroy();
  }

  expect(upgradeWebSocket).toHaveBeenCalledOnce();
  expect(upgradeHandler).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
  expect(syntheticRequest.url).toBe('/rewritten/alpha?existing=1&room=alpha');
});

test('propagates upgrade handler failures without invoking the HTTP handler', async () => {
  const expectedError = new Error('upgrade failed');
  const socket = new PassThrough();
  const handler = vi.fn(async () => {});
  const upgradeWebSocket = vi.fn(() => ({
    req: createRequest(),
    socket,
    head: Buffer.alloc(0),
  }));
  const upgradeHandler = vi.fn(async () => {
    throw expectedError;
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await withGeneratedLauncher(
      {
        requestContext: { upgradeWebSocket },
        routeModule: { handler, upgradeHandler },
      },
      async (launcher) => {
        await expect(
          launcher(createRequest(), {}, { requestId: 'failure' })
        ).rejects.toBe(expectedError);
      }
    );
  } finally {
    consoleError.mockRestore();
    socket.destroy();
  }

  expect(upgradeWebSocket).toHaveBeenCalledOnce();
  expect(upgradeHandler).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
});
