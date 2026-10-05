import { readFile } from 'fs-extra';
import { join } from 'path';
import { ConcatSource, OriginalSource, type Source } from 'webpack-sources';
import { template } from './edge-function-template';
import { raw, removeInlinedSourceMap, sourcemapped } from './sourcemapped';

/**
 * A partial Next.js configuration object that contains the required info
 * to parse the URL and figure out the pathname.
 */
interface NextConfig {
  basePath?: string;
  i18n?: {
    defaultLocale: string;
    domains?: {
      defaultLocale: string;
      domain: string;
      http?: boolean;
      locales?: string[];
    }[];
    localeDetection?: boolean;
    locales: string[];
  };
}

export interface NextjsParams {
  /**
   * The name of the function exposed in _ENTRIES that will be wrapped.
   */
  name: string;
  /**
   * An array with all static pages that the Next.js application contains.
   * This is required to estimate if a pathname will match a page.
   */
  staticRoutes: { page: string; namedRegex?: string }[];
  /**
   * An array with dynamic page names and their matching regular expression.
   * This is required to estimate if a request will match a dynamic page.
   */
  dynamicRoutes?: { page: string; namedRegex?: string }[];
  /**
   * The Next.js minimal configuration that the Middleware Edge Function
   * requires to parse the URL. This must include the locale config and
   * the basePath.
   */
  nextConfig: NextConfig | null;
}

/**
 * Allows to get the source code for a Next.js Edge Function where the output
 * is defined by a set of filePaths that compose all chunks. Those will write
 * to a global namespace _ENTRIES. The Next.js parameters will allow to adapt
 * the function into the core Edge Function signature.
 *
 * @param filePaths Array of relative file paths for the function chunks.
 * @param params Next.js parameters to adapt it to core edge functions.
 * @param outputDir The output directory the files in `filePaths` stored in.
 * @param wasm The wasm assets to import.
 * @param sourceCache Cache of loaded chunks, many edge functions share the
 * same chunks so this avoids reading them more than once.
 * @returns The source code of the edge function.
 */
export async function getNextjsEdgeFunctionSource(
  filePaths: string[],
  params: NextjsParams,
  outputDir: string,
  wasm?: Record<string, string>,
  sourceCache: Map<string, Promise<Source>> = new Map()
): Promise<Source> {
  const chunkSources = await Promise.all(
    filePaths.map((filePath) => {
      const fullFilePath = join(outputDir, filePath);
      let source = sourceCache.get(fullFilePath);
      if (!source) {
        // only the source is emitted (not a source map) so skip loading
        // and parsing the chunk's source map
        source = readFile(fullFilePath, 'utf8').then(
          (content) =>
            new OriginalSource(removeInlinedSourceMap(content), filePath)
        );
        sourceCache.set(fullFilePath, source);
      }
      return source;
    })
  );

  const chunks = new ConcatSource(raw(`globalThis._ENTRIES = {};`));
  for (const chunkSource of chunkSources) {
    chunks.add(raw(`\n/**/;`));
    chunks.add(chunkSource);
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
