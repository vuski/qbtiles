# PMTiles vs QBTiles: Real File Comparison

Read entries from real PMTiles files, serialize both as PMTiles and QBTiles, and compare index sizes.

## PMTiles Reader (Minimal Implementation)


```python
import sys, os, gzip, io, mmap, time
import numpy as np

sys.path.insert(0, os.path.join(os.getcwd(), "..", "src", "python"))
import qbtiles as qbt
import tileid_encoder


def read_varint(b_io):
    shift = result = 0
    while True:
        raw = b_io.read(1)
        if raw == b"":
            raise EOFError
        i = raw[0]
        result |= (i & 0x7F) << shift
        shift += 7
        if not (i & 0x80):
            break
    return result


class PMEntry:
    __slots__ = ("tile_id", "offset", "length", "run_length")
    def __init__(self, t, o, l, r):
        self.tile_id = t; self.offset = o; self.length = l; self.run_length = r


def deserialize_directory(buf):
    b_io = io.BytesIO(gzip.decompress(buf))
    entries = []
    n = read_varint(b_io)
    last_id = 0
    for i in range(n):
        tmp = read_varint(b_io)
        entries.append(PMEntry(last_id + tmp, 0, 0, 0))
        last_id += tmp
    for i in range(n):
        entries[i].run_length = read_varint(b_io)
    for i in range(n):
        entries[i].length = read_varint(b_io)
    for i in range(n):
        tmp = read_varint(b_io)
        if i > 0 and tmp == 0:
            entries[i].offset = entries[i - 1].offset + entries[i - 1].length
        else:
            entries[i].offset = tmp - 1
    return entries


def deserialize_header(buf):
    def r64(p):
        return int.from_bytes(buf[p:p+8], "little")
    return {
        "root_offset": r64(8),
        "root_length": r64(16),
        "leaf_directory_offset": r64(40),
        "leaf_directory_length": r64(48),
        "tile_entries_count": r64(80),
    }


def get_all_leaf_entries(filename):
    """Collect all leaf entries from a PMTiles file"""
    with open(filename, "rb") as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        header = deserialize_header(mm[0:127])
        all_entries = []

        def collect(off, length):
            d = deserialize_directory(mm[off:off + length])
            for e in d:
                if e.run_length == 0:
                    collect(header["leaf_directory_offset"] + e.offset, e.length)
                else:
                    all_entries.append(e)

        collect(header["root_offset"], header["root_length"])
        mm.close()
    return all_entries, header
```

## Comparison Function


```python
def compare_pmtiles_file(filepath):
    """Compare PMTiles vs QBTiles index size for a single file"""
    fname = os.path.basename(filepath)
    t_start = time.time()

    print(f"  Collecting entries...", end=" ", flush=True)
    entries, header = get_all_leaf_entries(filepath)
    n = len(entries)
    print(f"{n:,} entries, {time.time()-t_start:.1f}s")

    # Actual PMTiles directory size (from file header)
    pm_actual = header["root_length"] + header["leaf_directory_length"]

    # PMTiles single serialization (gzip)
    print(f"  Serializing PMTiles...", end=" ", flush=True)
    t0 = time.time()
    pm_entries = [qbt.Entry(e.tile_id, e.offset, e.length, e.run_length) for e in entries]
    pm_gz = qbt.serialize_directory(pm_entries)
    pm_gz_size = len(pm_gz)
    pm_raw_size = len(gzip.decompress(pm_gz))
    print(f"{time.time()-t0:.1f}s")

    # QBTiles serialization (gzip)
    # 1. Batch convert tile_id → quadkey via C++ encoder
    print(f"  Converting quadkeys (C++)...", end=" ", flush=True)
    t0 = time.time()
    tile_ids = np.array([e.tile_id for e in entries], dtype=np.uint64)
    quadkeys = tileid_encoder.encode_array(tile_ids)
    lengths = np.array([e.length for e in entries], dtype=np.int64)
    run_lengths = np.array([e.run_length for e in entries], dtype=np.int64)
    print(f"{time.time()-t0:.1f}s")

    # 2. Sort by quadkey
    print(f"  Sorting...", end=" ", flush=True)
    t0 = time.time()
    sort_idx = np.argsort(quadkeys)
    quadkeys = quadkeys[sort_idx]
    lengths = lengths[sort_idx]
    run_lengths = run_lengths[sort_idx]
    print(f"{time.time()-t0:.1f}s")

    # 3. Recalculate offsets as cumulative sum of lengths
    offsets = np.concatenate([[0], np.cumsum(lengths[:-1])])

    # 4. Build quadkey_info
    qk_info = list(zip(
        quadkeys.tolist(),
        [""] * n,
        offsets.tolist(),
        lengths.tolist(),
        run_lengths.tolist(),
    ))

    # 5. Build quadtree and serialize
    print(f"  Building quadtree...", end=" ", flush=True)
    t0 = time.time()
    root = qbt.build_quadtree(qk_info)
    print(f"{time.time()-t0:.1f}s")

    print(f"  Serializing QBTiles...", end=" ", flush=True)
    t0 = time.time()
    tmp = f"_tmp_{fname}.gz"
    qbt.write_tree_bitmask_to_single_file(root, tmp)
    qb_gz_size = os.path.getsize(tmp)
    with gzip.open(tmp, "rb") as f:
        qb_raw_size = len(f.read())
    os.remove(tmp)
    print(f"{time.time()-t0:.1f}s")

    print(f"  Total: {time.time()-t_start:.1f}s")

    return {
        "file": fname,
        "entries": n,
        "pm_actual": pm_actual,
        "pm_gz": pm_gz_size,
        "pm_raw": pm_raw_size,
        "qb_gz": qb_gz_size,
        "qb_raw": qb_raw_size,
    }
```

## PMTiles File Path

`examples/sample_adm_korea.pmtiles` (29MB) is included as a sample.
Change the path below to compare other PMTiles files.


```python
# Default: included sample file
pmtiles_folder = os.path.dirname(os.path.abspath("__file__"))

# Uncomment to compare files from another folder
# pmtiles_folder = r"Z:\Github\map-app-server\cache\fileRepository"

# List all .pmtiles files (sorted by size)
pmtiles_files = []
for f in os.listdir(pmtiles_folder):
    if f.endswith(".pmtiles"):
        path = os.path.join(pmtiles_folder, f)
        size = os.path.getsize(path)
        pmtiles_files.append((f, path, size))

pmtiles_files.sort(key=lambda x: x[2])

print(f"{'File':<35} {'Size':>12}")
print("-" * 50)
for f, path, size in pmtiles_files:
    if size > 1024**3:
        print(f"{f:<35} {size/1024**3:>10.1f} GB")
    else:
        print(f"{f:<35} {size/1024**2:>10.1f} MB")
```

## Run Comparison

Compare all files. Uses C++ tileid_encoder for fast quadkey conversion.


```python
results = []

for fname, path, size in pmtiles_files:
    if size > 1024**3:
        size_str = f"{size/1024**3:.1f} GB"
    else:
        size_str = f"{size/1024**2:.1f} MB"
    print(f"\n{'='*60}")
    print(f"{fname} ({size_str})")
    print(f"{'='*60}")
    try:
        r = compare_pmtiles_file(path)
        results.append(r)
    except Exception as ex:
        print(f"  ERROR: {ex}")
```

## Results Table


```python
print(f"{'File':<30} {'Entries':>10} {'PM actual':>12} {'PM(gz)':>12} {'QB(gz)':>12} {'PM raw':>12} {'QB raw':>12}")
print("-" * 105)

for r in results:
    print(
        f"{r['file']:<30} "
        f"{r['entries']:>10,} "
        f"{r['pm_actual']:>10,} B "
        f"{r['pm_gz']:>10,} B "
        f"{r['qb_gz']:>10,} B "
        f"{r['pm_raw']:>10,} B "
        f"{r['qb_raw']:>10,} B"
    )
```

## Ratio Comparison (gzip)


```python
print(f"{'File':<30} {'Entries':>10} {'PM(gz)':>10} {'QB(gz)':>10} {'QB/PM':>8} {'Diff':>10}")
print("-" * 75)

for r in results:
    ratio = r["qb_gz"] / r["pm_gz"] * 100
    diff = r["qb_gz"] - r["pm_gz"]
    marker = "< QB smaller" if diff < 0 else ""
    print(
        f"{r['file']:<30} "
        f"{r['entries']:>10,} "
        f"{r['pm_gz']:>8,} B "
        f"{r['qb_gz']:>8,} B "
        f"{ratio:>7.1f}% "
        f"{diff:>+9,} B {marker}"
    )
```

## Raw (Uncompressed) Size Comparison

Compare pre-gzip sizes as well.


```python
print(f"{'File':<30} {'Entries':>10} {'PM raw':>10} {'QB raw':>10} {'QB/PM':>8} {'Diff':>10}")
print("-" * 75)

for r in results:
    ratio = r["qb_raw"] / r["pm_raw"] * 100
    diff = r["qb_raw"] - r["pm_raw"]
    marker = "< QB smaller" if diff < 0 else ""
    print(
        f"{r['file']:<30} "
        f"{r['entries']:>10,} "
        f"{r['pm_raw']:>8,} B "
        f"{r['qb_raw']:>8,} B "
        f"{ratio:>7.1f}% "
        f"{diff:>+9,} B {marker}"
    )
```
