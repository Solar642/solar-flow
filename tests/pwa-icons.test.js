import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publicUrl = new URL('../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', publicUrl), 'utf8'));

function pngDimensions(path) {
  const png = readFileSync(new URL(path, publicUrl));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('PWA manifest declares installable any-purpose and maskable icons', () => {
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));

  for (const icon of manifest.icons.filter(item => item.type === 'image/png')) {
    const path = icon.src.replace(/^\/solar-flow\//, '');
    const { width, height } = pngDimensions(path);
    assert.equal(`${width}x${height}`, icon.sizes);
  }
});

test('iOS home-screen icon is linked and precached with the PWA shell', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('sw.js', publicUrl), 'utf8');
  assert.match(html, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
  assert.match(html, /apple-mobile-web-app-title" content="Solar Flow/);
  assert.deepEqual(pngDimensions('apple-touch-icon.png'), { width: 180, height: 180 });
  assert.match(serviceWorker, /solar-flow-v2/);
  assert.match(serviceWorker, /solar-flow\/favicon\.svg\?v=2/);
  assert.match(serviceWorker, /solar-flow\/icon-maskable-512\.png/);
  assert.match(serviceWorker, /solar-flow\/apple-touch-icon\.png/);
});
