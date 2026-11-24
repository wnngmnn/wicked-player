import { test, expect } from 'bun:test';
import { planVolumes, buildVolume, readVolume, validateManifest, parseFileIds } from '../src/app/album-sharing';
test('large album splits under 200MB and round-trips', async () => {
  const parts = planVolumes([80e6, 80e6].map(Math.round));
  expect(parts.length).toBe(2);
  const files = [new Blob([new Uint8Array(3000).fill(7)]), new Blob([new Uint8Array(2000).fill(9)])];
  const lp = planVolumes([3000, 2000], 4000);
  expect(lp.length).toBe(2);
  const manifest = { format:'wicked-album', version:1, id: crypto.randomUUID(), name:'A', artist:'B', tracks:[{name:'x',duration:1,size:3000},{name:'y',duration:1,size:2000}], parts: planVolumes([3000,2000]) } as any;
  const vol = await buildVolume({ manifest: validateManifest(manifest), files, cover: null }, 0);
  const r = await readVolume(vol);
  expect(r.entries['audio/1']?.[0]).toBe(9);
  expect(parseFileIds('https://pixeldrain.com/u/abcDEF12')).toEqual(['abcDEF12']);
  expect(() => parseFileIds('https://evil.com/u/abcDEF12')).toThrow();
});
