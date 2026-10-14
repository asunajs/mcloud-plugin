// smid 上报用的**纯数据**：指纹配置 + 25 条字段加密改名规则。
//
// ⚠ **这一份是从 `mcloud-sign/packages/shared/src/smid/index.ts`（TS 版）原样抽出来的**，
// 不是我照 Rust 重抄的。理由：这 147 行全是数据（`{cipher, is_encrypt, key, obfuscated_name}`），
// 而**手抄错一条的表现是"某个字段解出来是乱码"** —— 上游只会回一句参数错误，
// 看不出是哪一条。能原样搬就原样搬。
//
// 权威源：`/Users/catlair/mobile/workspace/mcloud-sign/packages/shared/src/smid/index.ts`
// （第 6-162 行），与 Rust 侧的 `mcloud/crates/mcloud-upstream/src/smid.rs:415-593` 同源。
//
// ⚠ `key` 是**加密密钥**，逐字照抄，别"顺手换个更像密码的"：
// 服务端按同一套规则解密，换一个就解不出来。

export const SKLAND_SM_CONFIG = {
  organization: "FXlyfmWg2AzwbrxDKSv5",
  appId: "default",
  publicKey:
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8KHAcHbkCn5rxGgGJE+07tY+pt86D/oZ7sA51FaEBv2jgno2TI9zHJVYKJynmiKpixgwUcv93EfWIrU/p/UCs5Vu+odS3I4UBp3R7IZ1A0W01FkumAHYW2PQpMm8ueQKPLUq/idkpG/9b2JDv/qU+Ks36nbUPwlW4CjdfrV+V9QIDAQAB",
  protocol: "https",
  apiHost: "slw.h5cmpassport.com:9090",
  apiPath: "/deviceprofile/v4",
};

export const DES_RULE = {
  appId: {
    cipher: "DES",
    is_encrypt: 1,
    key: "a9kbown8",
    obfuscated_name: "um",
  },
  box: {
    is_encrypt: 0,
    obfuscated_name: "aw",
  },
  canvas: {
    cipher: "DES",
    is_encrypt: 1,
    key: "ultuhs59",
    obfuscated_name: "iu",
  },
  clientSize: {
    cipher: "DES",
    is_encrypt: 1,
    key: "7s9eixjh",
    obfuscated_name: "na",
  },
  organization: {
    cipher: "DES",
    is_encrypt: 1,
    key: "14e30pp1",
    obfuscated_name: "nl",
  },
  os: {
    cipher: "DES",
    is_encrypt: 1,
    key: "j862vr1f",
    obfuscated_name: "lz",
  },
  platform: {
    cipher: "DES",
    is_encrypt: 1,
    key: "pgutfbo7",
    obfuscated_name: "lm",
  },
  plugins: {
    cipher: "DES",
    is_encrypt: 1,
    key: "x98c92bm",
    obfuscated_name: "hy",
  },
  pmf: {
    cipher: "DES",
    is_encrypt: 1,
    key: "gwvvsmr4",
    obfuscated_name: "yu",
  },
  protocol: {
    is_encrypt: 0,
    obfuscated_name: "protocol",
  },
  referer: {
    cipher: "DES",
    is_encrypt: 1,
    key: "gka1ljjt",
    obfuscated_name: "mf",
  },
  res: {
    cipher: "DES",
    is_encrypt: 1,
    key: "ht2n6dwf",
    obfuscated_name: "ut",
  },
  rtype: {
    cipher: "DES",
    is_encrypt: 1,
    key: "k2p9ifij",
    obfuscated_name: "fm",
  },
  sdkver: {
    cipher: "DES",
    is_encrypt: 1,
    key: "q4ij0mv5",
    obfuscated_name: "ir",
  },
  status: {
    cipher: "DES",
    is_encrypt: 1,
    key: "moyspi7i",
    obfuscated_name: "kp",
  },
  subVersion: {
    cipher: "DES",
    is_encrypt: 1,
    key: "egsyl21v",
    obfuscated_name: "dk",
  },
  svm: {
    cipher: "DES",
    is_encrypt: 1,
    key: "yf780e9w",
    obfuscated_name: "ee",
  },
  time: {
    cipher: "DES",
    is_encrypt: 1,
    key: "btb17oag",
    obfuscated_name: "jt",
  },
  timezone: {
    cipher: "DES",
    is_encrypt: 1,
    key: "l94h8clc",
    obfuscated_name: "bl",
  },
  tn: {
    cipher: "DES",
    is_encrypt: 1,
    key: "crnw0x7e",
    obfuscated_name: "as",
  },
  trees: {
    cipher: "DES",
    is_encrypt: 1,
    key: "x6the9nq",
    obfuscated_name: "ij",
  },
  ua: {
    cipher: "DES",
    is_encrypt: 1,
    key: "bewicpxu",
    obfuscated_name: "pu",
  },
  url: {
    cipher: "DES",
    is_encrypt: 1,
    key: "llj8yd1x",
    obfuscated_name: "sb",
  },
  version: {
    is_encrypt: 0,
    obfuscated_name: "version",
  },
  vpw: {
    cipher: "DES",
    is_encrypt: 1,
    key: "f1zlae4b",
    obfuscated_name: "qb",
  },
} as const;

/** 一条字段规则。`is_encrypt === 1` ⇒ 加密（用 `key`）并改名；否则**只改名**。 */
export interface DesRule {
  cipher?: string;
  is_encrypt: number;
  /** `is_encrypt === 0` 的那几条**没有**这个字段（不加密就不需要密钥）。 */
  key?: string;
  obfuscated_name: string;
}

/** ⚠ 是 `Readonly`：源表是 `as const` 的。写成可变的 `Record` 编译不过 ——
 *  而"为了过编译把 `as const` 去掉"会丢掉逐字字面量类型（那正是它的价值）。 */
export type DesRules = Readonly<Record<string, DesRule>>;

/** 规则表里**要加密**的那几条（Rust 侧的 `RULES` 也是这么分的）。 */
export function encryptedFields(rules: DesRules = DES_RULE): string[] {
  return Object.keys(rules).filter((k) => rules[k]!.is_encrypt === 1);
}

/** 规则表里**只改名不加密**的那几条 —— 这批最容易被漏掉（不加密 ⇒ 看着像"没规则"，于是
 *  忘了改名，字段名就原样发出去了）。 */
export function renamedOnlyFields(rules: DesRules = DES_RULE): string[] {
  return Object.keys(rules).filter((k) => rules[k]!.is_encrypt !== 1);
}
