import type { NextAdapter } from 'next';

type Context = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];
type Outputs = Context['outputs'];
type FunctionOutput =
  | Outputs['appPages'][number]
  | Outputs['appRoutes'][number]
  | Outputs['pages'][number]
  | Outputs['pagesApi'][number]
  | NonNullable<Outputs['middleware']>;

// Transport dictionaries only: output-generation policy stays in Go. Preserve
// map order and distinct values for the same key in different function outputs.
export function encodeOutputMaps(outputs: Outputs) {
  const bindings: Array<[string, string]> = [];
  const maps: number[][] = [];
  const valuesByKey = new Map<string, Map<string, number>>();
  const mapByIdentity = new WeakMap<Record<string, string>, number>();
  const mapByEntries = new Map<string, number>();
  const intern = (values: Record<string, string>) => {
    const previous = mapByIdentity.get(values);
    if (previous !== undefined) return previous;
    const refs: number[] = [];
    for (const key of Object.keys(values)) {
      const value = values[key];
      let byValue = valuesByKey.get(key);
      if (!byValue) {
        byValue = new Map();
        valuesByKey.set(key, byValue);
      }
      let index = byValue.get(value);
      if (index === undefined) {
        index = bindings.length;
        bindings.push([key, value]);
        byValue.set(value, index);
      }
      refs.push(index);
    }
    const fingerprint = refs.join(',');
    let index = mapByEntries.get(fingerprint);
    if (index === undefined) {
      index = maps.length;
      maps.push(refs);
      mapByEntries.set(fingerprint, index);
    }
    mapByIdentity.set(values, index);
    return index;
  };
  const pack = (output: FunctionOutput) => ({
    ...output,
    assets: undefined,
    assetsHashes: undefined,
    assetMapId: intern(output.assets),
    assetHashMapId:
      'assetsHashes' in output && output.assetsHashes
        ? intern(output.assetsHashes)
        : undefined,
  });
  return {
    assetBindings: bindings,
    assetMaps: maps,
    outputs: {
      ...outputs,
      appPages: outputs.appPages.map(pack),
      appRoutes: outputs.appRoutes.map(pack),
      pages: outputs.pages.map(pack),
      pagesApi: outputs.pagesApi.map(pack),
      middleware: outputs.middleware
        ? pack(outputs.middleware)
        : outputs.middleware,
    },
  };
}
