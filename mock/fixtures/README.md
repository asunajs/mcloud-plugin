# mock 领奖滑块夹具

`prize-picture.jpg.b64` / `prize-puzzle.png.b64` 是**离线生成**的一题滑块，
`mock/upstream.mjs` 用它来验「插件能不能自己把滑块算对」：

| 文件 | 是什么 |
|---|---|
| `prize-picture.jpg.b64` | 底图，**JPEG** 680×400（真实接口里就是 JPEG） |
| `prize-puzzle.png.b64` | 拼图竖切片，**PNG** 96×400 RGBA；只有碎片本体不透明 |
| 期望偏移 | **282** = 碎片在底图的 x（300）− 碎片在切片里的 x（18） |

⚠ 改图必须同时改 `mock/upstream.mjs` 的 `PRIZE_SLIDE_OFFSET`，否则 mock 会开始
拒绝**正确**的偏移（表现是"滑块怎么都过不去"，很容易查错方向）。

## 怎么重新生成

需要 Pillow（本机 `python3 -c "import PIL"` 可用即可）：

```bash
python3 - <<'PY'
from PIL import Image, ImageDraw
import random, base64, io

W, H = 680, 400
PZ_W, PZ_H = 96, 400
PIECE = 60
PX, PY = 300, 120      # 碎片在底图里的位置
SLICE_X = 18           # 碎片在 96 宽切片里的 x
OFFSET = PX - SLICE_X  # 282

random.seed(20261031)
img = Image.new('RGB', (W, H))
d = ImageDraw.Draw(img)
for y in range(H):
    for x in range(0, W, 2):
        r = int(40 + 120 * x / W + 30 * y / H)
        g = int(70 + 80 * y / H)
        b = int(150 - 60 * x / W + 40 * y / H)
        d.rectangle([x, y, x + 1, y], fill=(r, g, b))
for _ in range(26):
    x0 = random.randint(-40, W - 20); y0 = random.randint(-40, H - 20)
    w = random.randint(40, 140); h = random.randint(30, 110)
    c = (random.randint(20, 240), random.randint(20, 240), random.randint(20, 240))
    if random.random() < 0.5:
        d.rectangle([x0, y0, x0 + w, y0 + h], fill=c)
    else:
        d.ellipse([x0, y0, x0 + w, y0 + h], fill=c)

piece = img.crop((PX, PY, PX + PIECE, PY + PIECE))
hole = Image.new('RGBA', (PIECE, PIECE), (0, 0, 0, 0))
hd = ImageDraw.Draw(hole)
hd.rectangle([0, 0, PIECE - 1, PIECE - 1], fill=(70, 70, 80, 170))
hd.rectangle([1, 1, PIECE - 2, PIECE - 2], outline=(235, 235, 235, 255), width=2)
img.paste(Image.alpha_composite(
    img.crop((PX, PY, PX + PIECE, PY + PIECE)).convert('RGBA'), hole).convert('RGB'), (PX, PY))

slice_img = Image.new('RGBA', (PZ_W, PZ_H), (0, 0, 0, 0))
slice_img.paste(piece.convert('RGBA'), (SLICE_X, PY))

buf = io.BytesIO(); img.save(buf, 'JPEG', quality=82, optimize=True)
open('mock/fixtures/prize-picture.jpg.b64', 'w').write(base64.b64encode(buf.getvalue()).decode())
buf = io.BytesIO(); slice_img.save(buf, 'PNG', optimize=True)
open('mock/fixtures/prize-puzzle.png.b64', 'w').write(base64.b64encode(buf.getvalue()).decode())
print('offset', OFFSET)
PY
```

生成后可以用下面的脚本对拍（底图解码走 Pillow，切片走本仓的 PNG 解码器）：

```bash
python3 -c "from PIL import Image; import base64,io; \
im=Image.open(io.BytesIO(base64.b64decode(open('mock/fixtures/prize-picture.jpg.b64').read()))).convert('RGBA'); \
open('/tmp/prize-bg.rgba','wb').write(im.tobytes())"
node -e "
import('/Users/catlair/mobile/workspace/mcloud-plugin/src/mcloud/slide.ts').then(async (m) => {
  const fs = await import('node:fs');
  const { decodeImage } = await import('/Users/catlair/mobile/workspace/mcloud-plugin/src/crypto/png.ts');
  const bg = { data: new Uint8ClampedArray(fs.readFileSync('/tmp/prize-bg.rgba')), width: 680, height: 400 };
  const pz = decodeImage(fs.readFileSync('/tmp/prize-puzzle.png'));
  console.log(m.matchSlide(bg, pz, 680, 400, pz.width, pz.height));
});"
```
