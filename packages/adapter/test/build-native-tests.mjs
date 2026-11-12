import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../.native-tests/', import.meta.url));
mkdirSync(output, { recursive: true });
execFileSync(
  'go',
  [
    'test',
    '-c',
    '-o',
    `${output}adapter-tests${process.platform === 'win32' ? '.exe' : ''}`,
  ],
  {
    cwd: fileURLToPath(new URL('../native/', import.meta.url)),
    stdio: 'inherit',
  }
);
