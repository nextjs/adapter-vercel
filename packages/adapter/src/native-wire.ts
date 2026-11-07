import { endianness } from 'node:os';
import type { NextAdapter } from 'next';

type Context = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];
type Outputs = Context['outputs'];
type FunctionOutput =
  | Outputs['appPages'][number]
  | Outputs['appRoutes'][number]
  | Outputs['pages'][number]
  | Outputs['pagesApi'][number]
  | NonNullable<Outputs['middleware']>;

// JSON retains the small extensible hook context. Numeric trace references use
// a framed little-endian section instead of decimal JSON arrays. No application
// or runtime code crosses this protocol.
export function encodeNativeRequest(
  request: Record<string, unknown> & { assetMaps: number[][] }
) {
  const json = Buffer.from(
    JSON.stringify({ ...request, version: 3, assetMaps: undefined })
  );
  const maps = request.assetMaps;
  const words = 1 + maps.length + maps.reduce((n, refs) => n + refs.length, 0);
  // Align the numeric section so typed-array bulk copies can encode whole maps.
  // JSON accepts the trailing spaces included in its byte length.
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const payload = Buffer.allocUnsafeSlow(12 + jsonLength + words * 4);
  payload.write('NXTADP3\n', 0, 'ascii');
  payload.writeUInt32LE(jsonLength, 8);
  json.copy(payload, 12);
  payload.fill(0x20, 12 + json.length, 12 + jsonLength);
  if (endianness() === 'LE') {
    const values = new Uint32Array(
      payload.buffer,
      payload.byteOffset + 12 + jsonLength,
      words
    );
    let offset = 0;
    values[offset++] = maps.length;
    for (const refs of maps) {
      values[offset++] = refs.length;
      values.set(refs, offset);
      offset += refs.length;
    }
    return payload;
  }
  let offset = 12 + jsonLength;
  payload.writeUInt32LE(maps.length, offset);
  offset += 4;
  for (const refs of maps) {
    payload.writeUInt32LE(refs.length, offset);
    offset += 4;
    for (const id of refs) {
      payload.writeUInt32LE(id, offset);
      offset += 4;
    }
  }
  return payload;
}

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
  const pack = (output: FunctionOutput): Record<string, unknown> =>
    output.runtime === 'go'
      ? { ...output }
      : {
          ...output,
          assets: undefined,
          assetsHashes: undefined,
          assetMapId: intern(output.assets),
          assetHashMapId:
            'assetsHashes' in output && output.assetsHashes
              ? intern(output.assetsHashes)
              : undefined,
        };
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
