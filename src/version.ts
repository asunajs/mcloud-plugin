// 插件版本（**界面要显示它**：用户得知道"现在跑的是哪一版"）。
//
// ⚠ 这里必须与 `package.json` 的 `version` **一致** —— 由
// `test/version.test.ts` 钉住（两边不一致时 `npm test` 直接红）。
// 不靠构建脚本注入的理由：构建注入的那份只在**注释**里（`plugins/js/*.js` 文件头），
// 界面上读不到；而读 package.json 在插件沙箱里不可用。

export const PLUGIN_VERSION = '0.2.21';
