const assert = require('node:assert/strict');
const test = require('node:test');

const { getHandlerSource } = require('../dist/node-handler.js');

function createLauncher({ page, requestPath, routeModule, routeError }) {
  const spans = [];
  let routeRequires = 0;
  let handlerFinished = false;

  const span = {
    end() {
      spans[0].endedBeforeHandler = !handlerFinished;
    },
    recordException(error) {
      spans[0].exception = error;
    },
    setStatus(status) {
      spans[0].status = status;
    },
  };
  const otel = {
    SpanStatusCode: { ERROR: 2 },
    trace: {
      getTracer() {
        return {
          startActiveSpan(name, options, callback) {
            spans.push({ name, attributes: options.attributes });
            return callback(span);
          },
        };
      },
    },
  };
  const module = { exports: {} };
  const source = getHandlerSource({
    projectRelativeDistDir: '.next',
    prerenderFallbackFalseMap: {},
  });
  requestPath = requestPath ?? (page.replace(/\/(page|route)$/, '') || '/');
  const req = {
    headers: { host: 'example.test', 'x-matched-path': requestPath },
    url: requestPath,
  };

  function localRequire(id) {
    if (id === 'path') return require('node:path');
    if (id === 'next/setup-node-env') return {};
    if (id === 'next/dist/compiled/@opentelemetry/api') return otel;
    if (id.endsWith('.next/routes-manifest.json')) {
      return {
        dynamicRoutes: [],
        staticRoutes: [{ page: requestPath, regex: `^${requestPath}$` }],
      };
    }
    if (id.endsWith('.next/app-path-routes-manifest.json')) {
      return page === requestPath ? {} : { [page]: requestPath };
    }
    if (id.includes('/server/app/') || id.includes('/server/pages/')) {
      routeRequires += 1;
      if (routeError) throw routeError;
      return routeModule;
    }
    return {};
  }

  Function(
    'require',
    'module',
    '__dirname',
    'process',
    source
  )(localRequire, module, process.cwd(), { ...process, chdir() {} });

  return {
    async invoke() {
      await module.exports(req, {}, {});
      handlerFinished = true;
    },
    get routeRequires() {
      return routeRequires;
    },
    spans,
  };
}

test('traces a cold App Route entrypoint separately from its handler', async () => {
  let handlerCalls = 0;
  let resolveHandler;
  let markHandlerStarted;
  const handlerStarted = new Promise((resolve) => {
    markHandlerStarted = resolve;
  });
  const launcher = createLauncher({
    page: '/api/example/route',
    routeModule: {
      handler: () => {
        handlerCalls += 1;
        if (handlerCalls > 1) return;
        markHandlerStarted();
        return new Promise((resolve) => {
          resolveHandler = resolve;
        });
      },
    },
  });

  const invocation = launcher.invoke();
  await handlerStarted;

  assert.equal(launcher.routeRequires, 1);
  assert.deepEqual(launcher.spans, [
    {
      name: 'load route entrypoint',
      attributes: {
        'next.route': '/api/example',
        'next.router': 'app',
        'next.span_category': 'nextjs',
        'next.span_name': 'load route entrypoint',
        'next.span_type': 'NextLauncher.loadRouteEntrypoint',
      },
      endedBeforeHandler: true,
    },
  ]);

  resolveHandler();
  await invocation;
  await launcher.invoke();
  assert.equal(launcher.routeRequires, 1);
  assert.equal(launcher.spans.length, 1);
});

test('labels Pages Router entrypoints without filesystem attributes', async () => {
  const launcher = createLauncher({
    page: '/api/example',
    routeModule: { handler() {} },
  });

  await launcher.invoke();

  assert.deepEqual(launcher.spans, [
    {
      name: 'load route entrypoint',
      attributes: {
        'next.route': '/api/example',
        'next.router': 'pages',
        'next.span_category': 'nextjs',
        'next.span_name': 'load route entrypoint',
        'next.span_type': 'NextLauncher.loadRouteEntrypoint',
      },
      endedBeforeHandler: true,
    },
  ]);
});

test('records route entrypoint loading errors', async () => {
  const error = new Error('failed to load route entrypoint');
  const launcher = createLauncher({
    page: '/api/example/route',
    routeError: error,
  });

  await assert.rejects(launcher.invoke(), error);
  assert.equal(launcher.spans[0].exception, error);
  assert.deepEqual(launcher.spans[0].status, {
    code: 2,
    message: error.message,
  });
  assert.equal(launcher.spans[0].endedBeforeHandler, true);
});
