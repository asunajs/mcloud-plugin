#!/usr/bin/env python3
"""生成 `test/fixtures/jpeg-*.b64` 夹具（测试只读 .b64，运行测试不需要 Pillow）。

用法（在仓库根目录）：
    python3 test/fixtures/gen_jpeg_fixtures.py

为什么不是一行 Pillow 命令就够：
  · Pillow 的 `subsampling` 只能出 4:4:4 / 4:2:2 / 4:2:0；
  · Pillow（libjpeg）没有暴露 DRI/RSTn 的开关。
滑块底图实际只会是 4:2:0，但解码器声称支持任意 h/v 采样，4:1:1 和重启间隔
必须有一张真夹具，否则"支持"只是纸上的一句话。所以下面带了一个最小的基线
JPEG 编码器（只为本脚本服务）：用 Pillow 生成一张参考 JPEG，从它里面抄标准
DHT/DQT 表，再按指定采样因子 / DRI 重新编码同一张图。产物先让 Pillow 解一遍
（`python3 -c` 里对比），确认位流是合法的，再交给 TS 解码器对拍。
"""

from __future__ import annotations

import base64
import io
import math
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]


def draw_scene(width: int, height: int) -> Image.Image:
    """小图夹具的构图：四个色块 + 一条对角线，色块中心远离边界，方便断言。"""
    im = Image.new("RGB", (width, height), (244, 245, 239))
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, 30, 20], fill=(210, 50, 40))
    d.rectangle([32, 4, min(60, width - 1), 20], fill=(40, 120, 200))
    d.rectangle([4, 26, 30, min(43, height - 1)], fill=(30, 160, 90))
    d.rectangle([32, 26, min(60, width - 1), min(43, height - 1)], fill=(235, 190, 50))
    d.line([0, height - 1, width - 1, 0], fill=(20, 20, 20), width=2)
    return im


def draw_gray(width: int, height: int) -> Image.Image:
    """灰度夹具：四块灰阶 + 一条水平渐变（渐变能看出 IDCT 的行方向有没有错）。"""
    im = Image.new("L", (width, height), 200)
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, 30, 20], fill=40)
    d.rectangle([34, 4, width - 2, 20], fill=140)
    d.rectangle([4, 26, 30, height - 3], fill=100)
    for x in range(34, width - 1):
        v = round((x - 34) * 255 / max(1, width - 1 - 34))
        for y in range(26, height - 2):
            im.putpixel((x, y), v)
    return im


def draw_background(width: int, height: int) -> Image.Image:
    """680×400 主夹具：大色块 + 圆 + 斜线。滑块匹配吃的是边缘，这里保证横竖斜都有。"""
    im = Image.new("RGB", (width, height), (244, 245, 239))
    d = ImageDraw.Draw(im)
    d.rectangle([40, 40, 240, 200], fill=(30, 80, 200))
    d.rectangle([300, 80, 520, 180], fill=(220, 60, 50))
    d.rectangle([80, 260, 360, 360], fill=(40, 170, 90))
    d.rectangle([440, 230, 640, 370], fill=(250, 200, 40))
    d.ellipse([540, 20, 620, 100], fill=(90, 90, 90))
    d.line([0, height - 1, width - 1, 0], fill=(20, 20, 20), width=5)
    return im


# ══════════════════════════════ 最小基线 JPEG 编码器（仅本脚本） ══════════════════════════════
# 从 Pillow 的参考 JPEG 里抄标准表，目的是让产物用"别人写的表、自己的采样布局"，
# 这样至少 Huffman/量化这一半不是自产自销。


def parse_tables(jpeg: bytes) -> tuple[dict[int, list[int]], dict[tuple[int, int], tuple[list[int], list[int]]]]:
    qt: dict[int, list[int]] = {}
    ht: dict[tuple[int, int], tuple[list[int], list[int]]] = {}
    i = 2
    while i + 1 < len(jpeg):
        assert jpeg[i] == 0xFF, (i, jpeg[i])
        marker = jpeg[i + 1]
        i += 2
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        length = (jpeg[i] << 8) | jpeg[i + 1]
        seg = jpeg[i + 2 : i + length]
        i += length
        if marker == 0xDB:
            q = 0
            while q < len(seg):
                pq, tq = seg[q] >> 4, seg[q] & 15
                q += 1
                vals = []
                for _ in range(64):
                    if pq == 0:
                        vals.append(seg[q])
                        q += 1
                    else:
                        vals.append((seg[q] << 8) | seg[q + 1])
                        q += 2
                qt[tq] = vals
        elif marker == 0xC4:
            q = 0
            while q < len(seg):
                tcth = seg[q]
                q += 1
                counts = list(seg[q : q + 16])
                q += 16
                n = sum(counts)
                vals = list(seg[q : q + n])
                q += n
                ht[(tcth >> 4, tcth & 15)] = (counts, vals)
        elif marker == 0xDA:
            break
    return qt, ht


def huff_codes(counts: list[int], values: list[int]) -> dict[int, tuple[int, int]]:
    codes: dict[int, tuple[int, int]] = {}
    code = 0
    k = 0
    for length in range(1, 17):
        for _ in range(counts[length - 1]):
            codes[values[k]] = (code, length)
            code += 1
            k += 1
        code <<= 1
    return codes


class BitWriter:
    def __init__(self) -> None:
        self.buf = bytearray()
        self.cur = 0
        self.n = 0

    def write(self, val: int, nbits: int) -> None:
        for i in range(nbits - 1, -1, -1):
            self.cur = (self.cur << 1) | ((val >> i) & 1)
            self.n += 1
            if self.n == 8:
                self.buf.append(self.cur)
                if self.cur == 0xFF:
                    self.buf.append(0x00)  # 字节填充
                self.cur = 0
                self.n = 0

    def flush(self) -> None:
        if self.n:
            self.cur = (self.cur << (8 - self.n)) | ((1 << (8 - self.n)) - 1)
            self.buf.append(self.cur)
            if self.cur == 0xFF:
                self.buf.append(0x00)
            self.cur = 0
            self.n = 0


COS = [[math.cos((2 * x + 1) * u * math.pi / 16) for x in range(8)] for u in range(8)]


def fdct(block: list[list[float]]) -> list[list[float]]:
    out = [[0.0] * 8 for _ in range(8)]
    for v in range(8):
        cv = 1 / math.sqrt(2) if v == 0 else 1.0
        for u in range(8):
            cu = 1 / math.sqrt(2) if u == 0 else 1.0
            s = 0.0
            for y in range(8):
                row = block[y]
                for x in range(8):
                    s += row[x] * COS[u][x] * COS[v][y]
            out[v][u] = 0.25 * cu * cv * s
    return out


def rgb_to_ycbcr(r: int, g: int, b: int) -> tuple[float, float, float]:
    return (
        0.299 * r + 0.587 * g + 0.114 * b,
        128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
        128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
    )


def encode_custom(image: Image.Image, sampling: list[tuple[int, int, int]], restart: int = 0) -> bytes:
    width, height = image.size
    ref = io.BytesIO()
    image.save(ref, format="JPEG", quality=85, subsampling=2)
    qt, ht = parse_tables(ref.getvalue())
    dc0, ac0 = huff_codes(*ht[(0, 0)]), huff_codes(*ht[(1, 0)])
    dc1, ac1 = huff_codes(*ht[(0, 1)]), huff_codes(*ht[(1, 1)])

    pix = [[image.getpixel((x, y)) for x in range(width)] for y in range(height)]
    full = [[[0.0] * width for _ in range(height)] for _ in range(3)]
    for y in range(height):
        for x in range(width):
            r, g, b = pix[y][x]
            ycc = rgb_to_ycbcr(r, g, b)
            for c in range(3):
                full[c][y][x] = ycc[c]

    hmax = max(s[0] for s in sampling)
    vmax = max(s[1] for s in sampling)
    mcu_w = math.ceil(width / (8 * hmax))
    mcu_h = math.ceil(height / (8 * vmax))
    planes: list[list[list[float]]] = []
    for c, (hi, vi, _tq) in enumerate(sampling):
        cw = math.ceil(width * hi / hmax)
        ch = math.ceil(height * vi / vmax)
        kx, ky = hmax // hi, vmax // vi
        plane = [[0.0] * cw for _ in range(ch)]
        for cy in range(ch):
            for cx in range(cw):
                s = 0.0
                n = 0
                for y in range(cy * ky, min((cy + 1) * ky, height)):
                    for x in range(cx * kx, min((cx + 1) * kx, width)):
                        s += full[c][y][x]
                        n += 1
                plane[cy][cx] = s / n
        pw, ph = mcu_w * hi * 8, mcu_h * vi * 8
        padded = [[0.0] * pw for _ in range(ph)]
        for y in range(ph):
            sy = min(y, ch - 1)
            for x in range(pw):
                padded[y][x] = plane[sy][min(x, cw - 1)]
        planes.append(padded)

    bw = BitWriter()
    dc_pred = [0, 0, 0]

    def emit_block(block: list[list[float]], tqi: int, ci: int) -> None:
        f = fdct(block)
        zz = []
        for k in range(64):
            nat = ZIGZAG[k]
            zz.append(int(round(f[nat // 8][nat % 8] / qt[tqi][k])))
        diff = zz[0] - dc_pred[ci]
        dc_pred[ci] = zz[0]
        cat = abs(diff).bit_length()
        dccodes, accodes = (dc0, ac0) if tqi == 0 else (dc1, ac1)
        bw.write(*dccodes[cat])
        if cat:
            bw.write(diff if diff >= 0 else diff + (1 << cat) - 1, cat)
        run = 0
        for k in range(1, 64):
            v = zz[k]
            if v == 0:
                run += 1
                continue
            while run > 15:
                bw.write(*accodes[0xF0])
                run -= 16
            size = abs(v).bit_length()
            bw.write(*accodes[(run << 4) | size])
            bw.write(v if v >= 0 else v + (1 << size) - 1, size)
            run = 0
        if run > 0:
            bw.write(*accodes[0x00])

    total = mcu_w * mcu_h
    mcu = 0
    rst = 0
    for my in range(mcu_h):
        for mx in range(mcu_w):
            for ci, (hi, vi, tqi) in enumerate(sampling):
                plane = planes[ci]
                for vy in range(vi):
                    for hx in range(hi):
                        bx, by = mx * hi + hx, my * vi + vy
                        block = [
                            [plane[by * 8 + y][bx * 8 + x] - 128.0 for x in range(8)]
                            for y in range(8)
                        ]
                        emit_block(block, tqi, ci)
            mcu += 1
            if restart > 0 and mcu % restart == 0 and mcu < total:
                bw.flush()
                bw.buf += bytes([0xFF, 0xD0 + (rst & 7)])
                rst += 1
                dc_pred = [0, 0, 0]
    bw.flush()

    out = bytearray(b"\xff\xd8")
    out += b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    for tqi in (0, 1):
        out += b"\xff\xdb" + (67).to_bytes(2, "big") + bytes([tqi]) + bytes(qt[tqi])
    body = bytes([8]) + height.to_bytes(2, "big") + width.to_bytes(2, "big") + bytes([len(sampling)])
    for ci, (hi, vi, tqi) in enumerate(sampling):
        body += bytes([ci + 1, (hi << 4) | vi, tqi])
    out += b"\xff\xc0" + (len(body) + 2).to_bytes(2, "big") + body
    for tc, th in ((0, 0), (1, 0), (0, 1), (1, 1)):
        counts, vals = ht[(tc, th)]
        body = bytes([(tc << 4) | th]) + bytes(counts) + bytes(vals)
        out += b"\xff\xc4" + (len(body) + 2).to_bytes(2, "big") + body
    if restart > 0:
        out += b"\xff\xdd" + (4).to_bytes(2, "big") + restart.to_bytes(2, "big")
    body = bytes([len(sampling)])
    for ci in range(len(sampling)):
        td, ta = (0, 0) if ci == 0 else (1, 1)
        body += bytes([ci + 1, (td << 4) | ta])
    body += bytes([0, 63, 0])
    out += b"\xff\xda" + (len(body) + 2).to_bytes(2, "big") + body + bw.buf + b"\xff\xd9"
    return bytes(out)


# ══════════════════════════════ 产物 ══════════════════════════════


def write_b64(name: str, data: bytes) -> None:
    (HERE / name).write_text(base64.b64encode(data).decode("ascii") + "\n", encoding="ascii")
    print(f"{name}: {len(data)} bytes jpeg, {len(base64.b64encode(data))} bytes base64")


def save_pillow(im: Image.Image, name: str, quality: int, subsampling: int | None) -> bytes:
    buf = io.BytesIO()
    kwargs = {"quality": quality}
    if subsampling is not None and im.mode == "RGB":
        kwargs["subsampling"] = subsampling
    im.save(buf, format="JPEG", **kwargs)
    write_b64(name, buf.getvalue())
    return buf.getvalue()


def main() -> None:
    save_pillow(draw_background(680, 400), "jpeg-bg-680x400.b64", 82, 2)
    save_pillow(draw_scene(64, 48), "jpeg-small-444-64x48.b64", 85, 0)
    save_pillow(draw_scene(64, 48), "jpeg-small-422-64x48.b64", 85, 1)
    save_pillow(draw_gray(67, 45), "jpeg-gray-67x45.b64", 85, None)

    # 4:1:1 和 DRI/RSTn 是 Pillow 出不了的，用上面的最小编码器；尺寸故意取奇数（67×45），
    # 顺便测块补齐（右边/下边不足一个 MCU 时不能越界或错位）。
    img411 = draw_scene(67, 45)
    write_b64(
        "jpeg-small-411-67x45.b64",
        encode_custom(img411, [(4, 1, 0), (1, 1, 1), (1, 1, 1)]),
    )
    img_rst = draw_scene(64, 48)
    write_b64(
        "jpeg-restart-420-64x48.b64",
        encode_custom(img_rst, [(2, 2, 0), (1, 1, 1), (1, 1, 1)], restart=3),
    )


if __name__ == "__main__":
    main()
