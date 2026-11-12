// 2026-11-12 现场三条：
//   ① 云笔记：`authTokenRefresh` 现在回 **200 + 空体** ⇒ 拿 `auth` 兜底当 app_auth
//   ② 建笔记的成败**只能看回包有没有 noteid**（鉴权不对也给 200，正文是空模板）
//   ③ 算力大作战每天上传照片/备份，却从不登记到"我们的文件" ⇒ 网盘里越堆越多
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseNoteCreated } from '../src/mcloud/tasks/appTaskExtra.ts';

const src = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('建笔记判据：空模板不算建成，有 noteid 才算', () => {
  // 真机实拍（2026-11-12，鉴权没通过）：200 + 这个形状
  assert.equal(parseNoteCreated('{"version":"","noteid":"","createtime":"","title":"","notestatus":0}'), undefined);
  assert.equal(parseNoteCreated('{"noteid":"  abc123  "}'), 'abc123');
  assert.equal(parseNoteCreated('{"result":{"noteid":"r1"}}'), 'r1');
  assert.equal(parseNoteCreated(''), undefined);
  assert.equal(parseNoteCreated('not json'), undefined);
});

test('云笔记鉴权：拿不到 headers.app_auth 就用 auth 兜底（不再直接放弃）', () => {
  const d = src('src/mcloud/tasks/tokenPkActions.ts');
  assert.match(d, /let headers = parseNoteHeaders\(res\.text\);/, '先按老路取 headers');
  assert.match(d, /headers = \{ app_auth: raw \};/, '取不到就拿 auth 整串当 app_auth');
  assert.ok(!/鉴权响应里没有 headers\.app_auth'\);/.test(d), '不许再"没有 app_auth 就 fail"');
});

test('建笔记：按 parseNoteCreated 判成败，不许"200 就算建了"', () => {
  const d = src('src/mcloud/tasks/tokenPkActions.ts');
  assert.match(d, /parseNoteCreated\(res\.text\)/, '要看回包里的 noteid');
  assert.match(d, /云笔记没建成/, '没建成要如实说');
});

test('算力大作战：上传/快照造的文件要登记，链尾才删得掉', () => {
  const d = src('src/mcloud/tasks/tokenPkActions.ts');
  assert.match(d, /import \{ registerOwnedFile \} from '\.\/ownedFiles\.ts';/, '要引登记表');
  assert.match(d, /registerOwnedFile\(deps, fileId\)/, '上传完登记 fileId');
  assert.match(d, /ownedByUs !== false\) registerOwnedFile/, '撞上用户已有文件（false）不许登记');
  assert.match(d, /registerOwnedFile\(deps, parsed\.created\.fileId\)/, '快照也算我们的');
});
