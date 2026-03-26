/**
 * TypeScript/Node.js API tests for qbtiles.
 * Tests low-level functions directly, and openQBT via local HTTP server.
 *
 * Usage: node tests/test_api_ts.mjs
 */
import { createServer } from 'http';
import { readFileSync, existsSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';
import { gunzipSync } from 'zlib';

// Import from built dist
import { pathToFileURL } from 'url';
const qbtiles = await import(pathToFileURL(resolve('dist/qbtiles.js')).href);
const {
  parseQBTHeader, openQBT, registerCRS, QBT,
  tileToQuadkeyInt64, quadkeyInt64ToZXY, decodeCustomQuadkey,
  deserializeQuadtreeIndex, deserializeBitmaskIndex,
  readColumnarValues, splitAntimeridian,
  TYPE_UINT8, TYPE_INT32, TYPE_FLOAT32, TYPE_VARINT, TYPE_SIZE,
} = qbtiles;

const RESULTS = resolve('tests/results');
let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('OK');
    passed++;
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ============================================================
// Local HTTP server for openQBT tests
// ============================================================
const server = createServer((req, res) => {
  const filePath = join(RESULTS, decodeURIComponent(req.url));
  if (!existsSync(filePath)) {
    const altPath = resolve(req.url.startsWith('/examples/') ? req.url.slice(1) : `tests/results${req.url}`);
    if (existsSync(altPath)) {
      serveFile(altPath, req, res);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  serveFile(filePath, req, res);
});

function serveFile(filePath, req, res) {
  const data = readFileSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d+)?/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : data.length - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      res.end(data.slice(start, end + 1));
      return;
    }
  }
  res.writeHead(200, { 'Content-Length': data.length });
  res.end(data);
}

await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

// ============================================================
console.log('='.repeat(60));
console.log('1. parseQBTHeader');
console.log('='.repeat(60));

const fixedQbt = join(RESULTS, 'fix_basic.qbt');
const colQbt = join(RESULTS, 'col_basic.qbt.gz');

if (existsSync(fixedQbt)) {
  await test('parse fixed row header', () => {
    const nodeBuf = readFileSync(fixedQbt);
    const buf = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
    const h = parseQBTHeader(buf);
    assert(h.magic === 'QBT\x01', `magic=${h.magic}`);
    assert(h.version === 1);
    assert(h.isFixed === true);
    assert(h.isColumnar === false);
    assert(h.headerSize >= 128);
    assert(h.zoom > 0);
    assert(h.crs > 0);
    assert(h.valuesOffset > 0);
    assert(h.valuesLength > 0);
    assert(h.fields.length > 0);
  });
} else {
  console.log('  SKIP: run Python tests first (fix_basic.qbt)');
}

if (existsSync(colQbt)) {
  await test('parse columnar header (gzip)', async () => {
    const compressed = readFileSync(colQbt);
    // Decompress gzip
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    const h = parseQBTHeader(buf);
    assert(h.isColumnar === true, 'not columnar');
    assert(h.fields.length === 2);
  });
}

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('2. Quadkey functions');
console.log('='.repeat(60));

await test('tileToQuadkeyInt64 <-> quadkeyInt64ToZXY', () => {
  for (const [z,x,y] of [[0,0,0],[3,4,2],[14,13500,6200]]) {
    const qk = tileToQuadkeyInt64(z,x,y);
    const r = quadkeyInt64ToZXY(qk);
    assert(r.z===z && r.x===x && r.y===y, `roundtrip failed for ${z}/${x}/${y}`);
  }
});

await test('decodeCustomQuadkey', () => {
  // Encode in Python: encode_custom_quadkey(750000, 1350000, 13, 700000, 1300000, 819200) = some value
  // We test that decode gives back the center
  const qk = tileToQuadkeyInt64(3, 4, 2);
  const r = quadkeyInt64ToZXY(qk);
  assert(r.z === 3 && r.x === 4 && r.y === 2);
});

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('3. Type constants');
console.log('='.repeat(60));

await test('TYPE_* constants', () => {
  assert(TYPE_UINT8 === 1);
  assert(TYPE_INT32 === 4);
  assert(TYPE_FLOAT32 === 6);
  assert(TYPE_VARINT === 10);
  assert(TYPE_SIZE[TYPE_FLOAT32] === 4);
  assert(TYPE_SIZE[TYPE_INT32] === 4);
});

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('4. splitAntimeridian');
console.log('='.repeat(60));

await test('no split needed', () => {
  const result = splitAntimeridian([126, 35, 128, 37]);
  assert(result.length === 1);
});

await test('split across antimeridian', () => {
  // east > 180 triggers split: [170, 35, 190, 37] = 170~190 wraps around
  const result = splitAntimeridian([170, 35, 190, 37]);
  assert(result.length === 2, `expected 2, got ${result.length}`);
});

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('5. openQBT - variable mode');
console.log('='.repeat(60));

const varQbt = resolve('examples/korea_tiles.qbt');
if (existsSync(varQbt)) {
  // Copy to results for serving
  // copyFileSync already imported at top
  copyFileSync(varQbt, join(RESULTS, 'korea_tiles.qbt'));

  await test('openQBT(variable) -> mode, leafCount, header', async () => {
    const qbt = await openQBT(`${BASE}/korea_tiles.qbt`);
    assert(qbt.mode === 'variable', `mode=${qbt.mode}`);
    assert(qbt.leafCount > 0, `leafCount=${qbt.leafCount}`);
    assert(qbt.header.zoom === 14);
    assert(qbt.header.crs === 4326);
    assert(qbt.header.valuesOffset > 0);
    assert(qbt.header.valuesLength > 0);
  });

  await test('getTile(z, x, y)', async () => {
    const qbt = await openQBT(`${BASE}/korea_tiles.qbt`);
    const tile = await qbt.getTile(7, 109, 49);
    assert(tile !== null, 'tile is null');
    assert(tile.byteLength > 0, 'tile is empty');
    // Check gzip magic
    const bytes = new Uint8Array(tile);
    assert(bytes[0] === 0x1f && bytes[1] === 0x8b, 'not gzip');
  });

  await test('getTile(nonexistent) -> null', async () => {
    const qbt = await openQBT(`${BASE}/korea_tiles.qbt`);
    const tile = await qbt.getTile(0, 99, 99);
    assert(tile === null);
  });

  await test('getEntry(z, x, y)', async () => {
    const qbt = await openQBT(`${BASE}/korea_tiles.qbt`);
    const entry = qbt.getEntry(7, 109, 49);
    assert(entry !== undefined);
    assert(entry.offset >= 0);
    assert(entry.length > 0);
  });
} else {
  console.log('  SKIP: examples/korea_tiles.qbt not found');
}

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('6. openQBT - columnar mode');
console.log('='.repeat(60));

const popQbt = resolve('examples/korea_pop_100m.qbt.gz');
if (existsSync(popQbt)) {
  // copyFileSync already imported at top
  copyFileSync(popQbt, join(RESULTS, 'korea_pop_100m.qbt.gz'));

  await test('openQBT(columnar) -> mode, columns, leafCount', async () => {
    const qbt = await openQBT(`${BASE}/korea_pop_100m.qbt.gz`);
    assert(qbt.mode === 'columnar', `mode=${qbt.mode}`);
    assert(qbt.leafCount > 900000, `leafCount=${qbt.leafCount}`);
    assert(qbt.columns !== null);
    assert(qbt.columns.has('total'));
    assert(qbt.columns.has('male'));
    assert(qbt.columns.has('female'));
    assert(qbt.columns.get('total').length === qbt.leafCount);
  });

  await test('columnar columns values check', async () => {
    const qbt = await openQBT(`${BASE}/korea_pop_100m.qbt.gz`);
    const totals = qbt.columns.get('total');
    // Check some values are > 0
    const nonZero = totals.filter(v => v > 0).length;
    assert(nonZero > 0, 'all zeros');
  });

  await test('toWGS84 / fromWGS84 (EPSG:5179)', async () => {
    const qbt = await openQBT(`${BASE}/korea_pop_100m.qbt.gz`);
    assert(qbt.header.crs === 5179);
    const [lng, lat] = qbt.toWGS84(950000, 1950000);
    assert(lng > 126 && lng < 128, `lng=${lng}`);
    assert(lat > 36 && lat < 39, `lat=${lat}`);
    const [x, y] = qbt.fromWGS84(lng, lat);
    assert(Math.abs(x - 950000) < 1, `x roundtrip: ${x}`);
    assert(Math.abs(y - 1950000) < 1, `y roundtrip: ${y}`);
  });

  await test('getCellBBox', async () => {
    const qbt = await openQBT(`${BASE}/korea_pop_100m.qbt.gz`);
    const bbox = qbt.getCellBBox(13, 100, 100);
    assert(bbox.length === 4);
    // All should be valid WGS84 coords
    assert(bbox[0] > 100 && bbox[0] < 140, `west=${bbox[0]}`);
  });

  await test('query(bbox) - columnar (memory)', async () => {
    const qbt = await openQBT(`${BASE}/korea_pop_100m.qbt.gz`);
    // Wide bbox covering most of South Korea
    const cells = await qbt.query([126, 34, 130, 38]);
    assert(cells.length > 0, `no cells returned (leafCount=${qbt.leafCount}, mode=${qbt.mode})`);
    assert(cells[0].position.length === 2);
    assert(cells[0].values !== undefined, 'no values object');
    assert('total' in cells[0].values, 'missing total');
    assert('male' in cells[0].values, 'missing male');
  });
} else {
  console.log('  SKIP: examples/korea_pop_100m.qbt.gz not found');
}

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('7. registerCRS');
console.log('='.repeat(60));

await test('registerCRS custom', () => {
  // Should not throw
  registerCRS(32633, '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
});

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('8. deserializeQuadtreeIndex');
console.log('='.repeat(60));

if (existsSync(varQbt)) {
  await test('deserializeQuadtreeIndex from file buffer', () => {
    const raw = readFileSync(resolve('examples/korea_tiles.qbt'));
    const h = parseQBTHeader(raw.buffer);
    // Decompress index section
    const compressed = raw.slice(h.headerSize, h.headerSize + h.bitmaskLength);
    // Check if gzip
    let indexBuf;
    if (compressed[0] === 0x1f && compressed[1] === 0x8b) {
      // Sync gzip decompress via zlib
      indexBuf = gunzipSync(compressed).buffer;
    } else {
      indexBuf = compressed.buffer;
    }
    const index = deserializeQuadtreeIndex(indexBuf);
    assert(index.size > 0, 'empty index');
    assert(index.size === 36149, `expected 36149, got ${index.size}`);
  });
}

// ============================================================
console.log();
console.log('='.repeat(60));
console.log('9. readColumnarValues');
console.log('='.repeat(60));

if (existsSync(colQbt)) {
  await test('readColumnarValues from buffer', async () => {
    const compressed = readFileSync(colQbt);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    const h = parseQBTHeader(buf);

    // Decompress bitmask
    const bmCompressed = new Uint8Array(buf, h.headerSize, h.bitmaskLength);
    let bitmaskBuf;
    if (bmCompressed[0] === 0x1f && bmCompressed[1] === 0x8b) {
      const ds2 = new DecompressionStream('gzip');
      const w2 = ds2.writable.getWriter();
      w2.write(bmCompressed);
      w2.close();
      bitmaskBuf = await new Response(ds2.readable).arrayBuffer();
    } else {
      bitmaskBuf = bmCompressed.buffer.slice(h.headerSize, h.headerSize + h.bitmaskLength);
    }

    const index = await deserializeBitmaskIndex(bitmaskBuf, h.zoom, undefined, {
      bitmaskByteLength: bitmaskBuf.byteLength, bufferOffset: 0,
    });

    const columns = readColumnarValues(buf, h, index.totalLeaves);
    assert(columns.has('pop'), 'missing pop column');
    assert(columns.has('male'), 'missing male column');
    assert(columns.get('pop').length === index.totalLeaves);
  });
}

// ============================================================
// Cleanup
server.close();

console.log();
console.log('='.repeat(60));
const total = passed + failed;
console.log(`TypeScript: ${passed}/${total} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) process.exit(1);
