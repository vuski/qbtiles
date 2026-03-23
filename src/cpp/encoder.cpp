#include <stdint.h>
#include <stdio.h>

#ifdef _MSC_VER
#include <intrin.h>
#endif

uint8_t clzll(uint64_t x) {
    #ifdef _MSC_VER
        unsigned long index;
        if (_BitScanReverse64(&index, x))
            return 63 - index;
        else
            return 64;
    #else
        return __builtin_clzll(x);
    #endif
}


static void rotate(int s, uint32_t* x, uint32_t* y, int rx, int ry) {
    if (ry == 0) {
        if (rx == 1) {
            *x = s - 1 - *x;
            *y = s - 1 - *y;
        }
        // swap x and y
        int t = *x;
        *x = *y;
        *y = t;
    }
}

void tileid_to_zxy(uint64_t tile_id, uint8_t* z, uint32_t* x, uint32_t* y) {

    *z = clzll(3 * tile_id + 1);
    *z = (63 - *z) / 2;
    uint64_t acc = ((1ULL << (*z * 2)) - 1) / 3;
    uint64_t pos = tile_id - acc;

    *x = 0;
    *y = 0;
    uint32_t s = 1;
    uint32_t n = 1 << *z;

    while (s < n) {
        uint32_t rx = (pos / 2) & s;
        uint32_t ry = (pos ^ rx) & s;
        rotate(s, x, y, rx != 0, ry != 0);
        *x += rx;
        *y += ry;
        pos >>= 1;
        s <<= 1;
    }
}

uint64_t tile_to_quadkey_int64(uint8_t z, uint32_t x, uint32_t y) {
    uint64_t quadkey = 3;  // prefix '3' (0b11)

    for (int i = z - 1; i >= 0; i--) {
        uint64_t digit = ((y >> i) & 1) << 1 | ((x >> i) & 1);
        quadkey = (quadkey << 2) | digit;
    }

    return quadkey;
}

uint64_t tileid_to_quadkey_int64(uint64_t tile_id) {
    uint8_t z;
    uint32_t x, y;
    tileid_to_zxy(tile_id, &z, &x, &y);
    return tile_to_quadkey_int64(z, x, y);
}
