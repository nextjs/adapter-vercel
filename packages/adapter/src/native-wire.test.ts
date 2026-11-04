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
