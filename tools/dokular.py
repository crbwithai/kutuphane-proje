#!/usr/bin/env python3
"""
Doku görsellerini üretir: assets/grain.png (taş/deri için koyu gren) ve assets/grain-soft.png (parşömen).

Neden: CSS içindeki SVG feTurbulence filtresi tarayıcıda her çizimde yeniden hesaplanıyordu ve
açılışta/kaydırmada takılmaya yol açıyordu. Bir kez üretilen küçük PNG aynı görünümü bedavaya verir.
Kullanım: python3 tools/dokular.py   (yalnızca Python standart kütüphanesi)
"""
import os, random, struct, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets')


def png(path, w, h, pixel):
    """pixel(x, y) -> (r, g, b, a); 8 bit RGBA PNG yazar."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filtre: yok
        for x in range(w):
            raw.extend(pixel(x, y))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


def tileable_noise(w, h, seed, octaves=((1, .55), (2, .3), (4, .15))):
    """Kenarları birleşen (döşenebilir) yumuşak gürültü: 0..1"""
    rnd = random.Random(seed)
    layers = []
    for scale, weight in octaves:
        gw, gh = w // (8 // scale or 1), h // (8 // scale or 1)
        grid = [[rnd.random() for _ in range(gw)] for _ in range(gh)]
        layers.append((grid, gw, gh, weight))

    def at(x, y):
        v = 0.0
        for grid, gw, gh, weight in layers:
            fx, fy = x * gw / w, y * gh / h
            x0, y0 = int(fx), int(fy)
            tx, ty = fx - x0, fy - y0
            x1, y1 = (x0 + 1) % gw, (y0 + 1) % gh
            a = grid[y0 % gh][x0 % gw] * (1 - tx) + grid[y0 % gh][x1] * tx
            b = grid[y1][x0 % gw] * (1 - tx) + grid[y1][x1] * tx
            v += (a * (1 - ty) + b * ty) * weight
        return v
    return at


def main():
    os.makedirs(OUT, exist_ok=True)
    fine = random.Random(7)
    coarse = tileable_noise(160, 160, 11)
    # Koyu gren: siyah, saydamlığı ince taneli + iri lekeli gürültüden
    png(os.path.join(OUT, 'grain.png'), 160, 160,
        lambda x, y: (0, 0, 0, int(min(255, (fine.random() * 0.6 + coarse(x, y) * 0.7) * 120))))
    soft = tileable_noise(200, 200, 23)
    fine2 = random.Random(9)
    # Parşömen: sıcak kahve tonlu, hafif lekeli
    png(os.path.join(OUT, 'grain-soft.png'), 200, 200,
        lambda x, y: (90, 61, 26, int(min(255, (fine2.random() * 0.35 + soft(x, y) * 0.9) * 62))))
    for f in ('grain.png', 'grain-soft.png'):
        print(f, os.path.getsize(os.path.join(OUT, f)), 'bayt')


if __name__ == '__main__':
    main()
