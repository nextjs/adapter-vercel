import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADAPTER_PATH = path.join(process.cwd(), 'packages/adapter/dist/index.js');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function runBuild(fixturePath) {
  return new Promise((resolve, reject) => {
    console.log({ ADAPTER_PATH });
    const build = spawn('npx', ['next', 'build'], {
      cwd: fixturePath,
      env: {
        ...process.env,
        NEXT_ADAPTER_PATH: ADAPTER_PATH,
      },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    build.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    build.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    build.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Build failed with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });

    build.on('error', (err) => {
      reject(err);
    });
  });
}

async function installDependencies(fixturePath) {
  await fs.promises.rm(path.join(fixturePath, 'pnpm-lock.yaml'), {
    force: true,
  });
  await fs.promises.rm(path.join(fixturePath, 'node_modules'), {
    recursive: true,
    force: true,
  });

  return new Promise((resolve, reject) => {
    const install = spawn('pnpm', ['install', '--ignore-workspace'], {
      cwd: fixturePath,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    install.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    install.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    install.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Install failed with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });

    install.on('error', (err) => {
      reject(err);
    });
  });
}

describe('Next.js Adapter Tests', () => {
  beforeAll(() => {
    if (!fs.existsSync(ADAPTER_PATH)) {
      throw new Error(
        `Adapter not found at ${ADAPTER_PATH}. Please build the adapter first with: pnpm --filter adapter build`
      );
    }
  });

  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .map((name) => path.join(FIXTURES_DIR, name))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort();

  fixtures.forEach((fixture) => {
    const fixtureName = path.basename(fixture);

    it(`should build fixture: ${fixtureName}`, async () => {
      const packageJsonPath = path.join(fixture, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const nodeModulesPath = path.join(fixture, 'node_modules');
        if (!fs.existsSync(nodeModulesPath)) {
          await installDependencies(fixture);
        }
      }

      const result = await runBuild(fixture);
      expect(result).toBeDefined();
    });
  });
});
