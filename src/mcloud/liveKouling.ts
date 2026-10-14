// 直播口令提取 —— **算法档**：从原项目的 TS 源码逐字移植。
//
// 权威源：`mcloud-sign/packages/core/src/live-room/kouling.ts` 与 `xiaohongshu.ts`。
// （Rust 侧是同一份行为的第二次移植：`mcloud-upstream/src/live_kouling.rs`，
// 那里把两处"照抄会出错"的地方记成了文档 —— 本文件把它们也抄下来了。）
//
// # 为什么这一档可以用 mcloud-sign（四层权威，用户口径 2026-10-14 / F-026）
//
// ```text
//   ① 业务逻辑  → 照 mcloud        ② 内容 → 抓包核对
//   ③ ts 算法   → 参考 mcloud-sign ④ 效果 → 实测确认
// ```
//
// **本文件整个属于 ③**：它一条业务判据都没有 —— 输入是"一段文本"、输出是
// "里面有哪些像口令的东西"，与"该不该领、领哪条、什么时候停"无关。
// 那些判据在 `koulingPool.ts`（池）与 `tasks/liveRoomRules.ts`（编排层），
// 两份都照 mcloud。⚠ 改本文件前先问一句：**这是算法还是业务？**
// 若是业务（例如"提问要不要滤掉"这种产品决定），它的落点不在本文件。
//
// # 为什么是「逐字」而不是「照着重写一遍」
//
// 口令是**服务端当场校验**的：解错一个的代价是 `200108`（实拍证明零消耗）外加一次重听。
// 而"顺手把某个分支写得更严"的代价**不对称** —— 严过头会把**真口令**滤掉，
// 而口令只在直播那一小时有效，**没有第二次机会**。
//
// 所以下面这些看着像瑕疵的地方都是**行为契约**，不要"改进"：
//
//   · `口令是相伴什么` 会被解成口令 —— `相伴什么` 不在疑问词表里，所以它不是提问。
//     实拍弹幕里真有这一条，黄金向量把它钉成了契约。
//   · `小红花口令：AAA 无随机` 会**同时**命中格式 1 与格式 2 ⇒ 两条候选
//     （一条含收尾标记、一条不含）。看起来是重复，但它"更全"，收紧反而会切掉别的形状。
//   · `口令1:A口令2:B`（两条之间**没有**空白）**不切分** ⇒ 整段 `A口令2:B` 算一条。
//     这不是 bug：那个前瞻要求 `\s+`，没空白就不算下一个头。
//
// # 这一版比 Rust 那版**便宜**在哪（白拿的一处）
//
// Rust 的 `regex` 出于线性时间保证不支持前瞻，它的 `\s` 也只有 ASCII 六个
// （JS 的 `\s` 含全角空格 `U+3000`、NBSP、BOM）。所以那边要手写 `JS_SPACE_CLASS`，
// 还得把带前瞻的原式改成显式扫描（`same_line_codes`），并为此踩了
// "扫描该推进到头还是到尾"的坑（TS 的 `g` 是非重叠的）。
//
// **这些坑在 JS 里根本不存在** —— `\s` 就是 JS 的 `\s`，前瞻就是前瞻。
// 于是本文件可以直接用原式，包括那个带前瞻的 `SAME_LINE_PATTERN`。
// 这是"Rust 重写成 JS"里少见的、纯粹白拿的一处。
//
// # 一处**刻意**的偏离（唯一一处，写清楚免得后人以为是抄漏了）
//
// `decodeHtmlEntities` 里的 `String.fromCodePoint`：原 TS 对越界码点（`&#1114112;`）
// 会**抛 RangeError**，而那会让**整次提取**失败。这里改成保留实体原文
// —— 与 Rust 侧同一取舍。理由是不对称：保留原文最多多一个解不出口令的候选，
// 抛异常则会把整页的**真口令**一起丢掉。测试 `越界实体不炸整页` 钉住了这条。
//
// 纯函数：不 import host-api、不发请求、不读时钟。

/** 口令发布方的小红书主页。**公开页面，没有凭据** —— 口令除了直播弹幕之外
 *  还会在这里以笔记形式发一遍，所以它是 WebSocket 之外唯一的口令来源。 */
export const XIAOHONGSHU_KOULING_PROFILE_URL =
  'https://www.xiaohongshu.com/user/profile/568caf13aed7585949773b30';

/** 拉主页用的请求头。
 *
 *  ⚠ 这几个头不是"礼貌"问题：小红书对非常规 UA 会回一个**空壳页面**，
 *  而"空壳页面"与"这期没有口令"在解析层看起来**一模一样**（都返回 `[]`）
 *  —— 这正是必须逐字照抄伪装头的原因（真实客户端就是这么发的）。 */
export function xiaohongshuProfileHeaders(): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: 'https://www.xiaohongshu.com/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
}

// ══════════════════════════ 弹幕侧 ══════════════════════════

/** 整行只是个口令头（内容在**下一行/下一帧**）。
 *
 *  ⚠ 它与 `KoulingHeadPattern` **不是一回事**：这条要求"整行就是个头"
 *  （以冒号结尾），那条只要求"以口令二字开头"（`口令1：AAA` 也算）。
 *  用途也不同：这一条用在"下一行是不是又是个头"的**排除**里。 */
export function isKoulingHead(text: string): boolean {
  return /(?:复制)?口令\s*\d*\s*[：:]\s*$/.test(text.trim());
}

/** 这段文本**是否值得送进提取器**。
 *
 *  它的用处是**过滤**（小红书那边只对含关键词的候选文本做提取），
 *  所以它比 `extractKouling` 宽松得多 —— 宽了只是多算几次，**窄了会漏**。 */
export function hasKouling(text: string): boolean {
  return /口令|小红花/.test(text);
}

/** 弹幕格式的**收尾标记**（`无随机`）—— 它不是口令，是"这批口令到此为止"的记号。
 *
 *  ⚠ 为什么单独一个函数：**业务层**（人贴进来的那一栏要按分隔符切）需要这条判据，
 *  而"哪些字是收尾标记"是**算法层**的知识（[`extractKouling`] 的四个分支里
 *  有两处专门处理它）。让业务层自己写一个 `/无随机/` 就是把判据抄了两份 ——
 *  上游哪天真改成别的标记，漏改一处就静默多投一条假口令。 */
export function isKoulingMarker(text: string): boolean {
  return /无随机/.test(text);
}

/** 去掉口令**末尾的收批标记**。
 *
 *  上游在"这批口令到此为止"时会在尾部带上它，三种形态（2026-10-14 用户给的口径 + 实机样本）：
 *
 *  ```text
 *  秋游影集轻松做 无          ← 实机真收到过（当时被当成口令去领，回 200108 口令无效）
 *  秋游影集轻松做 无随机
 *  秋游影集轻松做无随机口令
 *  ```
 *
 *  ⚠⚠ `无` 那一条**必须**要求前面有空白。不然 `相伴到永远无` 这种"尾字本身是无"的
 *  真口令会被啃掉一个字 —— 而这种错**不会报错**，只会安静地换回一个 `200108`，
 *  所以判据宁可窄一点。
 *
 *  ⚠ 要**循环**去掉：`XX 无随机 无` 这种叠写真的会出现（收尾标记被转述了两次）。 */
export function trimKoulingTail(code: string): string {
  let out = code.trim();
  for (;;) {
    const before = out;
    // ⚠ 三条都要"**前面有空白**"或"**整串就是它**"：
    //   `XX 无` ⇒ 去；`无`（整串）⇒ 去；而 `相伴无`（尾字本身是无）**不能**动。
    // ⚠ `无随机口令` 这一条**不要求**前面的空白：它是五个字、语义明确
    //   （用户给的口径里就是"末尾是 …、无随机口令"），实拍形态是**连着**写的
    //   （`秋游影集轻松做无随机口令`）。另两条才必须靠空白兜住
    //   —— `无` 一个字，误伤的代价是"安静地少一个字、白跑一枪 200108"。
    out = out.replace(/\s*无随机口令$/, '');
    out = out.replace(/(?:^|\s+)无随机$/, '');
    out = out.replace(/(?:^|\s+)无$/, '');
    out = out.trim();
    if (out === before) break;
  }
  return out;
}

/** 疑问句末尾的语气词。 */
const TRAILING_PARTICLE = /[呀啊吧呢嘛哦]+$/;

/** "整条就是一句提问"的那几个词。
 *
 *  ⚠ 判据是**去语气词后整条相等**，不是"包含"：`口令是相伴什么` 不在表里，
 *  所以它会被解成口令（原实现如此）。用"包含"会把 `口令是带着云盘去上学` 误伤掉。 */
const QUESTION_WORDS = ['什么', '啥', '多少', '几', '哪个', '哪些'];

/** 解出来的"口令"其实是不是观众的一句提问。
 *
 *  弹幕里大量出现 `口令是什么` / `第2个口令是什么？` —— 它们是**观众在问**，
 *  不是主播在发。不滤掉的话每一次都会换回一个 `200108`。
 *
 *  ⚠ 它的输入是**解出来的候选**，不是整句话：`isQuestion('口令是什么')` 为 **false**
 *  （整句不等于任何疑问词），而 `extractKouling('口令是什么')` 走格式 3 解出 `什么`
 *  ⇒ 到这一步才被滤掉。判据作用在候选上，这条很容易写错方向。 */
export function isQuestion(code: string): boolean {
  if (/[?？]/.test(code)) return true;
  const t = code.replace(TRAILING_PARTICLE, '');
  return QUESTION_WORDS.includes(t);
}

/** 一行**裸文本**（没走格式提取的那种）是不是一句"在问口令"的话。
 *
 *  为什么需要它：`isQuestion` 判的是候选，而人直接贴进来的是一整句话。
 *  `口令是什么` 走提取会解出 `什么` 然后被滤掉 ⇒ 提取路径自己就挡住了；
 *  但**逐行原文**那条路会把整行原样当口令收下。所以这里把"剥掉口令前缀再看"
 *  这件事显式做一遍。
 *
 *  ⚠ 剥前缀只剥 `第N个口令(是|：)` 这一种形态，**不剥**别的 ——
 *  剥多了会把 `口令红包雨` 这种真口令剥成 `红包雨`。 */
export function looksLikeQuestionAboutKouling(line: string): boolean {
  if (/[?？]/.test(line)) return true;
  const stripped = line.replace(/^第?\d*个?口令\s*[是为：:]?\s*/, '').trim();
  return isQuestion(line) || isQuestion(stripped);
}

/** 同一行里的多个口令头 —— **原式的逐字拷贝**（含前瞻）。
 *
 *  原式：`/(?:复制)?口令\s*\d*\s*[：:]\s*(.*?)(?=\s+(?:复制)?口令\s*\d*\s*[：:]|无随机|$)/g`
 *
 *  每个头的内容到下面三者中**最先**出现的一个为止：
 *    ① 一个**以空白开头**的下一个口令头；② `无随机`（**没有**前导空白要求）；③ 行尾。
 *
 *  ⚠ 原实现把它写在循环内部、每次迭代重建。提到模块级是等价的：
 *  `String.prototype.matchAll` **不改源正则的 `lastIndex`**（它内部克隆一份再迭代），
 *  所以复用一个 `g` 正则不会串味。 */
const SAME_LINE_PATTERN =
  /(?:复制)?口令\s*\d*\s*[：:]\s*(.*?)(?=\s+(?:复制)?口令\s*\d*\s*[：:]|无随机|$)/g;

/** 从一条弹幕里提取口令。
 *
 *  # 四个分支**按顺序累加**（不是"命中一个就返回"）
 *
 *  ```text
 *  ① `小红花口令：XXX`
 *  ② 逐行扫口令头：整行是头 ⇒ 取**下一行**（然后 continue，**不再**做同行切分）；
 *     行内有头 ⇒ 用 SAME_LINE_PATTERN 切
 *  ③ `口令是XXX`
 *  ④ **仅当 ①②③ 全空**且文本含 `无随机` ⇒ 按空白切、找 `N:XXX`
 *  ```
 *
 *  顺序不是风格：③ 的 `口令是(.+)` 会命中 ② 里那些行的内容，
 *  而 ④ 是"上面都没认出来时的最后兜底"，条件里那句 `result.length === 0` **不能省**
 *  （省了它，多行格式会额外多出一批垃圾）。
 *
 *  最后**保序去重**（`[...new Set()]`）再过一遍疑问句过滤 ——
 *  顺序对"先拿到哪个口令"有影响（先领哪一条），去重则防止同一个口令被领两次。 */
export function extractKouling(msg: string): string[] {
  const result: string[] = [];

  // ① `小红花口令：XXX`
  const m2 = msg.match(/小红花口令[：:]\s*(.+)/);
  if (m2 && m2[1] !== undefined) result.push(m2[1].trim());

  // ② 逐行
  const lines = msg.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    // 整行只是口令头 ⇒ 取下一行，然后 continue（原实现那个 continue 就是这个意思；
    // 漏掉它会让 `复制口令1：` 这一行既取到下一行、又被同行切分算一遍）
    if (isKoulingHead(line)) {
      const next = lines[i + 1];
      if (next !== undefined) {
        // ⚠ 以前这里是"含 `无随机` 就整条丢掉"——那会把 `秋游影集轻松做 无随机`
        //   这种**带尾巴的真口令**一起丢掉。改成**去尾巴后照样收下**
        //   （只余标记的那一行会在末尾清空，自然被滤掉）。
        const content = trimKoulingTail(next.trim());
        if (content && !/^(?:复制)?口令/.test(content)) {
          result.push(content);
        }
      }
      continue;
    }
    // 同行多个口令
    for (const match of line.matchAll(SAME_LINE_PATTERN)) {
      const code = trimKoulingTail((match[1] ?? '').trim());
      if (code) result.push(code);
    }
  }

  // ③ `口令是XXX`
  const m1 = msg.match(/口令是(.+)/);
  if (m1 && m1[1] !== undefined) result.push(m1[1].trim());

  // ④ 纯数字编号兜底：**只在前面全空**时才走
  if (result.length === 0 && /无随机/.test(msg)) {
    // ⚠ `.replace(/无随机.*/, "")` 是**非全局**替换：只去掉第一处以及它**本行**的剩余
    // （JS 的 `.` 不跨行）。改成全局会多去掉后面几行，而那正好是"多行格式"的形状。
    const parts = msg
      .replace(/无随机.*/, '')
      .trim()
      .split(/\s+/);
    for (const part of parts) {
      const v = part.match(/^\d+\s*[：:]\s*(.+)/);
      if (v && v[1] !== undefined) {
        const code = v[1].trim();
        if (code) result.push(code);
      }
    }
  }

  // ⚠ 去尾巴放在**这里**（四条分支唯一的汇合点）：分支多、以后还会加，
  //   只在一个出口做，就不会出现"某条分支忘了去尾巴"这种漏。
  //   去完可能不再是空串（于是又出现重复），所以**先去尾巴再去重**。
  return [...new Set(result.map(trimKoulingTail))].filter((code) => code !== '' && !isQuestion(code));
}

// ══════════════════════════ 小红书主页侧 ══════════════════════════

/** 原实现认的那**六个**具名实体。
 *
 *  ⚠ 只有六个：多认几个**看起来**更对，但那是**行为变化**
 *  （原实现会把 `&copy;` 原样留在文本里）。口令里出现实体的概率极低，
 *  而"两边解出不同的文本"会让黄金向量失去意义。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** 解 HTML 实体（数字、hex、六个具名）。认不出的具名实体**原样保留**。
 *
 *  ⚠ 唯一一处刻意偏离原 TS：越界码点（`&#1114112;`）原 TS 的 `String.fromCodePoint`
 *  会抛 RangeError ⇒ **整次提取失败**。这里保留原文（见文件头"一处刻意的偏离"）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (entity, decimal, hex, named) => {
    if (typeof decimal === 'string' && decimal !== '') {
      const n = Number(decimal);
      return safeFromCodePoint(n, entity);
    }
    if (typeof hex === 'string' && hex !== '') {
      return safeFromCodePoint(Number.parseInt(hex, 16), entity);
    }
    if (typeof named === 'string') {
      return NAMED_ENTITIES[named.toLowerCase()] ?? entity;
    }
    return entity;
  });
}

/** `String.fromCodePoint` 的宽版：越界就返回原文，而不是抛出去炸掉整页。 */
function safeFromCodePoint(n: number, fallback: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

/** 把一个 JSON 字符串**体**（不含引号）解成原文。
 *
 *  先按 JSON 解（正确路径），解不开再手工替换 —— 顺序照抄原实现
 *  （`\\n` → `\\r` → `\\t` → `\\"` → `\\\\`）。顺序有意义：
 *  先替换 `\\"` 会把 `\\\\\\"` 这种转义序列切错。 */
export function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

/** 把一段 HTML 片段压成纯文本。 */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:a|article|div|h\d|li|p|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

/** 按四级顺序收集**含关键词**的候选文本。
 *
 *  ```text
 *  ① 内嵌 JSON 的 `displayTitle` / `title` / `desc`（服务端注水的那份状态）
 *  ② 服务端渲染的笔记卡片（`<a|article|div|h\d|p>` 里的文本）
 *  ③ `<meta content="…">`（SEO 元数据）
 *  ④ 整页纯文本逐行兜底
 *  ```
 *
 *  顺序就是**页面顺序**，而主页按时间倒序 ⇒ 第一条命中即最新笔记。 */
export function collectCandidateTexts(html: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    // ⚠ 这里是 JS 的 `/\s+/g`，**不是** `htmlToText` 里那个 `[ \t]+`。
    // 差别在换行：内嵌 JSON 的 `"口令是A\nB"` 解出来是**带换行**的两行，
    // 折成空格才是原实现喂给提取器的形状。用 `[ \t]+` 的话换行留着，
    // 而 `extractKouling` 的 `口令是(.+)` 遇换行就停 ⇒ 解出半个口令。
    const text = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
    if (!text || !hasKouling(text) || seen.has(text)) return;
    seen.add(text);
    candidates.push(text);
  };

  // ① 小红书服务端内嵌状态中的笔记标题和正文
  const jsonFieldPattern = /"(?:displayTitle|title|desc)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of html.matchAll(jsonFieldPattern)) add(decodeJsonString(match[1] ?? ''));

  // ② 服务端渲染的笔记卡片
  const elementPattern = /<(?:a|article|div|h\d|p)[^>]*>([\s\S]*?)<\/(?:a|article|div|h\d|p)>/gi;
  for (const match of html.matchAll(elementPattern)) add(htmlToText(match[1] ?? ''));

  // ③ SEO 元数据
  const metaPattern = /<meta\b[^>]*(?:content=["']([^"']+)["'])[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) add(match[1] ?? '');

  // ④ 保底：整页纯文本逐行。按页面顺序保留候选，第一条有效结果即最新笔记。
  for (const line of htmlToText(html).split(/\r?\n/)) add(line);

  return candidates;
}

/** 从主页 HTML 里提取**最新一条**口令；没有就是**空数组**（不是 null）。
 *
 *  # 为什么"第一条命中即返回"
 *
 *  主页按时间倒序 ⇒ 页面顺序第一条可解析的口令笔记就是最新的那一期。
 *  继续往下找会把**历史口令**也交出去，而那些一律回 `200108`
 *  —— 除了白跑一趟，还会让"无效口令 ⇒ 重听一次"这条逻辑被自己触发的噪声带偏。 */
export function extractKoulingFromXiaohongshuHtml(html: string): string[] {
  for (const candidate of collectCandidateTexts(html)) {
    const codes = extractKouling(candidate);
    if (codes.length > 0) return codes;
  }
  return [];
}

// ══════════════════════════ 输入口：人给的口令 ══════════════════════════

/** 人**贴进来**的一条口令（或多条）。
 *
 *  为什么需要这个口：口令本身**没法自动化** —— 它由主播在直播里发，
 *  小红书那条也只能由人从页面上抄下来（那边无法鉴权）。能自动的是"抓主页"，
 *  不能自动的是"口令本身"。这是两件事，所以这里是人给的口。 */
export interface CodeInput {
  ok: boolean;
  codes: string[];
  /** 这次**是怎么解出来的** —— 界面/日志要能说清"你贴的东西我当成了什么" */
  how: string;
  /** 走的是**哪条路**：`true` = 按弹幕格式解出来的（①），`false` = 按逐行原文收下的（②）。
   *
   *  ⚠ 这一格是给**业务层**用的：两条路的"再加工"不同 —— 格式解出来的口令
   *  **不能**再按空白切（它就是一条整口令），而"逐行原文"那条要过一遍
   *  `splitKouling`（分隔符含空白/逗号/顿号，见 `liveRoomRules.ts` 的理由）。
   *  让业务层去猜 `how` 那句话的意思，就是把判据建在文案上。 */
  matchedFormat: boolean;
  error?: string;
}

/** 单条口令的长度上限。**这是护栏，不是规则** —— 真实口令是中文短语（几个字到十几个字）。
 *  超过这个长度的东西几乎不可能是口令，而它会进 SQLite、进日志、进界面。 */
export const MAX_CODE_CHARS = 128;
/** 一次最多存几条。一场直播也就发两三条。 */
export const MAX_CODES = 10;

/** 解析人贴进来的东西。
 *
 *  两条路：
 *    ① 先按**弹幕格式**解（`复制口令1：XXX`、`口令是XXX`……）—— 人常常直接复制弹幕原文
 *    ② 解不出来就按**逐行原文**当口令（人从页面抄下来的就是裸口令，没有任何格式）
 *
 *  ⚠ 两条路都不接受**提问**：`口令是什么` 是观众在问，拿去领只会换回 `200108`。
 *  这一条用 `isQuestion` 判，与原提取器同一个判据。 */
export function parseCodeInput(raw: string): CodeInput {
  const text = raw.trim();
  if (!text) return { ok: false, codes: [], how: '', matchedFormat: false, error: '先贴一条口令' };

  // ① 按弹幕格式解
  const extracted = extractKouling(text);
  if (extracted.length > 0) {
    return finish(extracted, `按弹幕格式解出 ${extracted.length} 条`, true);
  }

  // ② 逐行原文
  const lines = text
    .split(/\r?\n/)
    .map((l) => trimKoulingTail(l))
    .filter((l) => l !== '');
  if (lines.length === 0) {
    return { ok: false, codes: [], how: '', matchedFormat: false, error: '先贴一条口令' };
  }

  const bad = lines.find((l) => looksLikeQuestionAboutKouling(l));
  if (bad !== undefined) {
    return {
      ok: false,
      codes: [],
      how: '',
      matchedFormat: false,
      error: `「${bad.slice(0, 20)}」看着是观众的提问，不是口令 —— 拿去领只会白跑一枪（上游回 200108）`,
    };
  }
  return finish(lines, `按原文收下 ${lines.length} 条（没匹配到任何弹幕格式）`, false);
}

/** 口令条数的护栏：**与提取逻辑无关**，所以单独一个函数。
 *
 *  ⚠ 为什么要把这一小段抽出来：业务层（`saveLiveCodes`）在"逐行原文"那条路上
 *  会**先按分隔符再切一次**（`splitKouling`），切完的条数可能比这里看到的多
 *  ⇒ 护栏必须能**在切完之后再判一次**。不抽出来的话，要么业务层自己抄一遍
 *  （判据分叉），要么切开之后的超限没人管。 */
export function checkCodeLimits(codes: readonly string[]): CodeInput {
  return finish(codes.slice(), '（只做护栏检查）', false);
}

function finish(codes: string[], how: string, matchedFormat: boolean): CodeInput {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ''))];
  const tooLong = uniq.find((c) => c.length > MAX_CODE_CHARS);
  if (tooLong !== undefined) {
    return {
      ok: false,
      codes: [],
      how: '',
      matchedFormat: false,
      error: `有一条 ${tooLong.length} 个字符，超过 ${MAX_CODE_CHARS} 的上限 —— 这不像口令`,
    };
  }
  if (uniq.length > MAX_CODES) {
    return {
      ok: false,
      codes: [],
      how: '',
      matchedFormat: false,
      error: `一次最多 ${MAX_CODES} 条（收到 ${uniq.length} 条）`,
    };
  }
  return { ok: true, codes: uniq, how, matchedFormat };
}
