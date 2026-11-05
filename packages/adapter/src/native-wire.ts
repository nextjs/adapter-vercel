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
  const valuesByKey = new Map<
    string,
    {
      value: string;
      index: number;
      second?: { value: string; index: number };
      others?: Map<string, number>;
    }
  >();
  const mapByIdentity = new WeakMap<Record<string, string>, number>();
  const mapByHash = new Map<number, number[]>();
  const intern = (values: Record<string, string>) => {
    const previous = mapByIdentity.get(values);
    if (previous !== undefined) return previous;
    const refs: number[] = [];
    let fingerprint = 2166136261;
    for (const key of Object.keys(values)) {
      const value = values[key];
      const binding = valuesByKey.get(key);
      let index: number;
      if (!binding) {
        index = bindings.length;
        bindings.push([key, value]);
        valuesByKey.set(key, { value, index });
      } else if (binding.value === value) {
        index = binding.index;
      } else if (!binding.second) {
        index = bindings.length;
        bindings.push([key, value]);
        binding.second = { value, index };
      } else if (binding.second.value === value) {
        index = binding.second.index;
      } else {
        let alternate = binding.others?.get(value);
        if (alternate === undefined) {
          alternate = bindings.length;
          bindings.push([key, value]);
          binding.others ||= new Map();
          binding.others.set(value, alternate);
        }
        index = alternate;
      }
      refs.push(index);
      fingerprint = Math.imul(fingerprint ^ index, 16777619);
    }
    const candidates = mapByHash.get(fingerprint);
    // A hash only selects a bucket. Equality still checks every reference.
    let index = candidates?.find(
      (id) =>
        maps[id].length === refs.length &&
        maps[id].every((entry, i) => entry === refs[i])
    );
    if (index === undefined) {
      index = maps.length;
      maps.push(refs);
      if (candidates) candidates.push(index);
      else mapByHash.set(fingerprint, [index]);
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
