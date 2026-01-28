import { readFile } from 'fs-extra';
import { join } from 'path';
import { ConcatSource, type Source } from 'webpack-sources';
import { template } from './edge-function-template';
import type { NextjsParams } from './get-edge-function';
import { fileToSource, raw, sourcemapped } from './sourcemapped';

/**
 * Allows to get the source code for a Next.js Edge Function where the output
 * is defined by a set of filePaths that compose all chunks. Those will write
 * to a global namespace _ENTRIES. The Next.js parameters will allow to adapt
 * the function into the core Edge Function signature.
 *
 * @param filePaths Array of relative file paths for the function chunks.
 * @param params Next.js parameters to adapt it to core edge functions.
 * @param outputDir The output directory the files in `filePaths` stored in.
 * @returns The source code of the edge function.
 */
export async function getNextjsEdgeFunctionSource(
  filePaths: string[],
  params: NextjsParams,
  outputDir: string,
  wasm?: Record<string, string>
): Promise<Source> {
  const chunks = new ConcatSource(raw(`globalThis._ENTRIES = {};`));
  for (const filePath of filePaths) {
    const fullFilePath = join(outputDir, filePath);
    const content = await readFile(fullFilePath, 'utf8');
    chunks.add(raw(`\n/**/;`));
    chunks.add(await fileToSource(content, filePath, fullFilePath));
  }

  // Wrap to fake module.exports
  const getPageMatchCode = `(function () {
    const module = { exports: {}, loaded: false };
    const fn = (function(module,exports) {${template}\n});
    fn(module, module.exports);
    return module.exports;
  })`;

  return sourcemapped`
  ${raw(getWasmImportStatements(wasm || {}))}
  ${chunks};
  export default ${raw(getPageMatchCode)}.call({}).default(
    ${raw(JSON.stringify(params))}
  )`;
}

function getWasmImportStatements(wasm: Record<string, string>) {
  return Object.entries(wasm)
    .filter(([name]) => name.startsWith('wasm_'))
    .map(([name]) => {
      const pathname = `/wasm/${name}.wasm`;
      return `const ${name} = require(${JSON.stringify(pathname)});`;
    })
    .join('\n');
}
