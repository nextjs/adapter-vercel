import { expect, it } from 'vitest';
import { encodeOutputMaps } from './native-wire';

type Outputs = Parameters<typeof encodeOutputMaps>[0];

it('shares repeated metadata without changing output-specific values or order', () => {
  const assets = { a: '/repo/a', b: '/repo/b' };
  const outputs = {
    appPages: Array.from({ length: 1000 }, () => ({
      assets: { ...assets },
      assetsHashes: { a: 'hash-a', b: 'hash-b' },
    })),
    appRoutes: [{ assets: { ...assets, a: '/repo/different' } }],
    pages: [{ assets, assetsHashes: {} }],
    pagesApi: [{ assets: { b: '/repo/b', a: '/repo/a' } }],
    middleware: undefined,
  } as unknown as Outputs;
  const before = JSON.stringify(outputs);
  const encoded = encodeOutputMaps(outputs);
  expect(JSON.stringify(outputs)).toBe(before);
  expect(encoded.assetBindings).toHaveLength(5);
  expect(encoded.assetMaps).toHaveLength(5);
  expect(new Set(encoded.outputs.appPages.map((o) => o.assetMapId)).size).toBe(
    1
  );
  expect(encoded.outputs.pages[0].assetHashMapId).toBeDefined();
  expect(encoded.outputs.appRoutes[0].assetHashMapId).toBeUndefined();
  const unpack = (id: number) =>
    encoded.assetMaps[id].map((i) => encoded.assetBindings[i]);
  expect(unpack(encoded.outputs.appRoutes[0].assetMapId)).toEqual([
    ['a', '/repo/different'],
    ['b', '/repo/b'],
  ]);
  expect(unpack(encoded.outputs.pagesApi[0].assetMapId)).toEqual([
    ['b', '/repo/b'],
    ['a', '/repo/a'],
  ]);
  expect(JSON.stringify(encoded).length).toBeLessThan(before.length / 2);
});

it('keeps different ordered maps distinct when their transport hashes collide', () => {
  const left = [4, 73, 83, 25, 60, 96, 43, 68];
  const right = [81, 30, 37, 95, 28, 83, 80, 50];
  const assets = (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [`asset-${id}`, `/repo/${id}`]));
  const encoded = encodeOutputMaps({
    appPages: [
      { assets: assets(Array.from({ length: 100 }, (_, i) => i)) },
      { assets: assets(left) },
      { assets: assets(right) },
    ],
    appRoutes: [],
    pages: [],
    pagesApi: [],
    middleware: undefined,
  } as unknown as Outputs);
  const a = encoded.outputs.appPages[1].assetMapId;
  const b = encoded.outputs.appPages[2].assetMapId;
  expect(a).not.toBe(b);
  expect(encoded.assetMaps[a]).toEqual(left);
  expect(encoded.assetMaps[b]).toEqual(right);
});
