const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { promisify } = require('node:util');
const { normalizeRoutes } = require('@vercel/routing-utils');
const { getHandlerSource } = require('../dist/node-handler');

const execFileAsync = promisify(execFile);
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

async function createBuiltNextFixture() {
  const adapterRepoRoot = path.resolve(
    await realpath(path.join(__dirname, '../node_modules')),
    '../../..'
  );
  const fixtureDir = await mkdtemp(
    path.join(adapterRepoRoot, '.tmp-adapter-build-')
  );
  tempDirs.push(fixtureDir);

  const nextPackageDir = path.dirname(require.resolve('next/package.json'));
  const resolvePeerPackage = (name) =>
    path.dirname(
      require.resolve(`${name}/package.json`, {
        paths: [nextPackageDir],
      })
    );

  await mkdir(path.join(fixtureDir, 'node_modules'), { recursive: true });
  await Promise.all(
    [
      ['next', nextPackageDir],
      ['react', resolvePeerPackage('react')],
      ['react-dom', resolvePeerPackage('react-dom')],
    ].map(([name, packageDir]) =>
      symlink(packageDir, path.join(fixtureDir, 'node_modules', name), 'dir')
    )
  );

  await writeModule(
    path.join(fixtureDir, 'app/layout.js'),
    `
      export default function RootLayout({ children }) {
        return <html><body>{children}</body></html>;
      }
    `
  );
  await writeModule(
    path.join(fixtureDir, 'app/api/health/route.js'),
    `
      export function GET() {
        return Response.json({ ok: true });
      }
    `
  );
  await writeModule(
    path.join(fixtureDir, 'app/api/[slug]/route.js'),
    `
      export function GET(_request, { params }) {
        return Response.json(params);
      }
    `
  );
  await writeFile(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify({ private: true })
  );
  await writeFile(
    path.join(fixtureDir, 'next.config.js'),
    `module.exports = {
      adapterPath: ${JSON.stringify(path.resolve(__dirname, '../dist/index.js'))},
      turbopack: {
        root: ${JSON.stringify(adapterRepoRoot)},
      },
    };`
  );

  await execFileAsync(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'build'],
    {
      cwd: fixtureDir,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  return fixtureDir;
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

describe('node handler route matching', () => {
  it('returns 404 when an encoded pathname misses the bundled route', async () => {
    const handler = await createFixture();

    assert.deepEqual(await invoke(handler, '/api/health'), {
      status: 200,
      body: 'health',
    });
    assert.deepEqual(await invoke(handler, '/api/%68ealth'), {
      status: 404,
      body: 'This page could not be found',
    });
    assert.deepEqual(await invoke(handler, '/api/%68ealth', 'POST'), {
      status: 404,
      body: 'This page could not be found',
    });
  });

  it(
    'rejects encoded static aliases before filesystem hits',
    { timeout: 180_000 },
    async () => {
      const fixtureDir = await createBuiltNextFixture();
      const outputConfig = JSON.parse(
        await readFile(
          path.join(fixtureDir, '.next/output/config.json'),
          'utf8'
        )
      );

      assert.equal(normalizeRoutes(outputConfig.routes).error, null);

      const hitIndex = outputConfig.routes.findIndex(
        (route) => route.handle === 'hit'
      );
      const encodedAliasIndex = outputConfig.routes.findIndex(
        (route) =>
          route.status === 404 &&
          typeof route.src === 'string' &&
          route.src.includes('%(?:')
      );

      assert.ok(encodedAliasIndex !== -1);
      assert.equal(encodedAliasIndex, hitIndex - 1);

      const encodedAliasRoute = outputConfig.routes[encodedAliasIndex];
      const dynamicRouteIndex = outputConfig.routes.findIndex(
        (route) =>
          typeof route.dest === 'string' &&
          route.dest.startsWith('/api/[slug]?')
      );
      assert.ok(dynamicRouteIndex !== -1);
      assert.ok(dynamicRouteIndex < encodedAliasIndex);
      assert.equal(
        new RegExp(outputConfig.routes[dynamicRouteIndex].src).test(
          '/api/%68ealth'
        ),
        true
      );

      const matcher = new RegExp(encodedAliasRoute.src);
      assert.equal(matcher.test('/api/%68ealth'), true);
      assert.equal(matcher.test('/api/%2Fhealth'), false);
      assert.ok(encodedAliasRoute.dest !== '/api/health');

      const healthFunctionConfig = JSON.parse(
        await readFile(
          path.join(
            fixtureDir,
            '.next/output/functions/api/health.func/.vc-config.json'
          ),
          'utf8'
        )
      );
      assert.equal(
        Object.keys(healthFunctionConfig.filePathMap).some((filePath) =>
          filePath.includes('/_not-found/')
        ),
        false
      );
    }
  );
});
