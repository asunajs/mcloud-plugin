# mock 夹具（领奖滑块 + 直播失败注入）

## 领奖滑块

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
import('<本仓库>/src/mcloud/slide.ts').then(async (m) => {
  const fs = await import('node:fs');
  const { decodeImage } = await import('<本仓库>/src/crypto/png.ts');
  const bg = { data: new Uint8ClampedArray(fs.readFileSync('/tmp/prize-bg.rgba')), width: 680, height: 400 };
  const pz = decodeImage(fs.readFileSync('/tmp/prize-puzzle.png'));
  console.log(m.matchSlide(bg, pz, 680, 400, pz.width, pz.height));
});"
```

## 直播接口与失败注入（upstream.mjs）

`mock/upstream.mjs` 除领奖滑块外，还原了直播链的全部后端口（三套信封不可混用）：

| 族 | 端点 | 信封 / 数据键 |
|---|---|---|
| 门（`gateBase`） | `/user/querySpecTokenV2`（`toSourceId=017027`）、`/api/user/auth/cmpassLoginByCmToken`、`/api/channel/channel/tabContentList`（tabId 127/129）、`/api/user/customer/userToken`、`/api/room/front/roomBeat` | `{rtnCode:"0", object}`（字符串码） |
| 领红花（`baseUrl`） | `/ycloud/liveRoomFeedback/user/info`、`/ycloud/visitlog/journaling`、`/ycloud/liveRoomFeedback/firstParticipate/give`、`/ycloud/liveRoomFeedback/redFlower/draw`、`/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers` | `{code:0, result}`（数字码） |
| IM（`imBase`） | `/v3/room/member/apply` | `{code:0, data, timestamp}`（数字码） |
| 口令页（`liveUrl`） | `/xhs/profile` | 大于 5 KB 的伪装 HTML |
| 弹幕（`wsBase`） | `ws://…/ws/<serverId>/<sessionId>/websocket` | SockJS 帧 `o` / `a["b64"]` + MSync 字节 |

四个基址在面板上分别配置；手工联调时都指向同一个 mock 即可：

```bash
node mock/upstream.mjs 18080
# 面板配置（POST /plugins/mcloud/api/config）：
#   baseUrl = http://127.0.0.1:18080   gateBase = http://127.0.0.1:18080
#   imBase  = http://127.0.0.1:18080   wsBase  = ws://127.0.0.1:18080
#   liveUrl = http://127.0.0.1:18080/xhs/profile
```

### 失败 / 边界分支的可控注入

直播族有**独立**的失败开关（与签到族的 `/_debug/behavior` 分开，互不污染）：

| 口子 | 作用 |
|---|---|
| `POST /_debug/live/behavior` `{"behavior":"normal|biz-fail|http-500|not-json|timeout"}` | 对门/领红花/IM/口令页统一注入失败；三套信封各回各的失败形状 |
| `POST /_debug/live/state` `{"liveChatRoomId":null}` | roomBeat 回「没有聊天室」⇒ 插件不该发 member/apply、不该开 WS |
| `POST /_debug/ws/heartbeat` | 推一帧 SockJS 心跳 `h`（插件不应误关连接） |
| `POST /_debug/ws/close` | 推一帧 SockJS 关闭 `[""]`（插件应如实收尾） |

### 自动随机弹幕流（像真直播间）

WS 连上并 PROVISION 后，mock 会**每隔 1.5~4 秒自动推一条弹幕**，内容 80% 闲聊、
12% 提问、8% 口令（口令藏在 `DANMAKU_KOULING` 里，不会一上来就发）。文本都经过
插件 `extractKouling` 验证：闲聊/提问解不出口令，所以不会污染口令池。

- `GET /_debug/ws` 的 `autoDanmaku` / `history` 可观察开关与历史；
- `POST /_debug/ws/auto {"enabled":false}` 可关；`MOCK_AUTO_DANMAKU=0 node mock/upstream.mjs` 从启动就关（e2e 用这个保证确定性）；
- `ws.auto` / `ws.setAuto()` / `ws.history` 是模块调用时的对应口子。
口令文本即 draw 的分支选择器（省掉按顺序计数的麻烦）：含「过期」→ `200118`、含「无效」→ `200108`、含「领过」→ `200112`、其余 → `code=0` + 10 朵。

**多账号语义**（`200112` 是按账号，不是按口令）：mock 的 `liveDrawClaims` 用 `"<jwttoken>|<口令>"` 记账 —— 口令是共享资源，jwt 才是账号标识。同一口令不同账号各领一次都成功；只有**同一账号**重复领才回 `200112`。为支撑这一点，`querySpecTokenV2` 会从 Basic 凭据里解出手机号回 `SSO-MOCK-<手机>`，`tyrzLogin` 再据此发 `JWT-MOCK-<手机>`，所以每个账号的 jwt 不同。`test/mock-live-contract.test.ts` 的两条多账号用例钉住了这套语义。

⚠ 每段用例测完**务必复位** `live/behavior:normal` 与 `liveChatRoomId`，否则后续用例会在不知情的情况下走失败分支。`test/mock-live-contract.test.ts` 直接对着这些口做端到端契约断言。