# Quadkey Int64 인코딩

## 표준 Quadkey

지도 tile은 각 zoom level마다 4개로 분할된다. 각 분할에 0–3의 digit를 부여하면 tile 위치를 문자열로 표현할 수 있다.

```
Level 1:  4 tiles   (0, 1, 2, 3)
Level 2:  16 tiles  (00, 01, 02, 03, 10, 11, ..., 33)
Level 3:  64 tiles  (000, 001, ..., 333)
...
Level z:  4^z tiles
```

각 digit는 2×2 분할 내 위치를 나타낸다: 0=좌상, 1=우상, 2=좌하, 3=우하.

각 digit의 bit 인코딩:
```
digit = ((y >> i) & 1) << 1 | ((x >> i) & 1)

  digit 0: x=0, y=0 (top-left)
  digit 1: x=1, y=0 (top-right)
  digit 2: x=0, y=1 (bottom-left)
  digit 3: x=1, y=1 (bottom-right)
```

## 문자열의 한계

Quadkey 문자열을 정수로 변환하면 빠른 정렬/비교가 가능하지만, 모호성이 발생한다:

```
"0"   → 0
"00"  → 0   ← 구분 불가!
"000" → 0   ← 구분 불가!
"032" → 32
"0032"→ 32  ← 구분 불가!
```

서로 다른 zoom level이 동일한 정수를 만들어낸다.

## 0b11 Prefix 기법

해결책: **`3` (binary `11`)**을 prefix sentinel로 앞에 붙인다.

```
"0"   → "30"    → binary: 11 00             → int 12
"00"  → "300"   → binary: 11 00 00          → int 48
"000" → "3000"  → binary: 11 00 00 00       → int 192
"032" → "3032"  → binary: 11 00 11 10       → int 206
```

모든 값이 고유한 정수가 된다.

### 왜 `3`인가?

각 quadkey digit는 0, 1, 2, 3 중 하나다. `3`은 유효한 digit이지만, **첫 번째 위치에서는 오직 prefix sentinel 역할만 수행한다**. Binary로 `11`이므로, 2-bit 쌍을 순회할 때 `11`을 만나면 "실제 quadkey가 여기서 시작된다"는 의미다.

## 변환 함수

### z/x/y → int64

```python
def tile_to_quadkey_int64(z, x, y):
    quadkey_int64 = 3  # prefix 0b11
    for i in reversed(range(z)):
        digit = ((y >> i) & 1) << 1 | ((x >> i) & 1)
        quadkey_int64 = (quadkey_int64 << 2) | digit
    return quadkey_int64
```

### int64 → z/x/y

```python
def quadkey_int64_to_zxy(qint64):
    x = y = 0
    found_prefix = False
    z = 0
    for shift in reversed(range(0, 64, 2)):
        digit = (qint64 >> shift) & 0b11
        if not found_prefix:
            if digit == 0b11:
                found_prefix = True
            continue
        x = (x << 1) | (digit & 1)
        y = (y << 1) | ((digit >> 1) & 1)
        z += 1
    return z, x, y
```

## 특성

- **정렬 가능**: int64 quadkey 정렬이 공간적 인접성을 유지
- **컴팩트**: 가변 길이 문자열 대신 고정 64-bit 정수 사용
- **Zoom 범위**: 64 bits - 2 bits (prefix) = 62 bits / 2 bits per level = **최대 zoom 31**
- **빠른 순회**: 정수 연산으로 부모-자식 관계 탐색
    - 부모 quadkey = 자식 quadkey >> 2
    - 자식 quadkey = (부모 quadkey << 2) | digit
