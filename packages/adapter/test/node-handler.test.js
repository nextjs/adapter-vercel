const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { getHandlerSource } = require('../dist/node-handler');

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true }))
  );
});

async function writeModule(filePath, source) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source);
}

async function createFixture() {
  const fixtureDir = await mkdtemp(
    path.join(tmpdir(), 'adapter-node-handler-')
  );
  tempDirs.push(fixtureDir);

  await writeModule(
    path.join(fixtureDir, 'node_modules/next/setup-node-env.js'),
    ''
  );
  await writeModule(
    path.join(fixtureDir, '.next/server/app/api/health/route.js'),
    `
      module.exports.handler = async (_req, res) => {
        res.statusCode = 200;
        res.end('health');
      };
    `
  );
  await writeFile(
    path.join(fixtureDir, '.next/routes-manifest.json'),
    JSON.stringify({
      dynamicRoutes: [],
      staticRoutes: [
        {
          page: '/api/health',
          regex: '^/api/health$',
          namedRegex: '^/api/health$',
        },
      ],
    })
  );
  await writeFile(
    path.join(fixtureDir, '.next/app-path-routes-manifest.json'),
    JSON.stringify({
      '/api/health/route': '/api/health',
    })
  );

  const launcherPath = path.join(fixtureDir, '___next_launcher.cjs');
  await writeFile(
    launcherPath,
    getHandlerSource({
      projectRelativeDistDir: '.next',
      prerenderFallbackFalseMap: {},
    })
  );

  const originalCwd = process.cwd();
  const handler = require(launcherPath);
  process.chdir(originalCwd);

  return handler;
}

async function invoke(handler, pathname, method = 'GET') {
  const req = {
    headers: {
      host: 'localhost',
      'x-matched-path': pathname,
    },
    method,
    url: pathname,
  };
  let body = '';
  const res = {
    statusCode: 200,
    end(chunk) {
      body += chunk?.toString() || '';
    },
  };

  await handler(req, res, {});

  return { status: res.statusCode, body };
}

test('returns 404 when an encoded pathname misses the bundled route', async () => {
  const handler = await createFixture();

  assert.deepEqual(await invoke(handler, '/api/health'), {
    status: 200,
    body: 'health',
  });
  assert.equal((await invoke(handler, '/api/%68ealth', 'POST')).status, 404);
});
