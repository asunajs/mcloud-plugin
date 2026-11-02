import { fromBase64 } from '../crypto/bytes.ts';

// 算力大作战上传类任务（`uploadPhoto` / `backup`）用的那张示例图。
//
// 为什么是常量而不是现生成：本仓没有 JPEG **编码器**（只有解码器，见 `crypto/jpeg.ts`），
// 而这两条任务要的是"一张真的 JPEG"（参照实现用 `GenerateUniqueSampleJPEG(600, 800)`）。
// 所以离线生成一次（Pillow，64×64、669 字节、`quality=60`），把字节固化在这里：
// 形状稳定 ⇒ 夹具可复现、`contentHash` 可复现，也不用为这一件事再引一套编码器。
//
// ⚠ 改这张图 = 改所有上传任务的 `contentHash`。真要换图，用同一条命令重生成：
//   `python3 -c "from PIL import Image,ImageDraw; ..."`（见 `docs/upload-chain.md`）
//   —— 或者干脆别换：这张图对"触发一次上传/备份"没有任何业务含义。

/** 64×64 的真 JPEG（`FF D8 FF … FF D9`），669 字节。 */
export const SAMPLE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABAAEADASIAAhEBAxEB/8QAGQABAQADAQAAAAAAAAAAAAAABAIAAQUD/8QAJBAAAgECBQUBAQAAAAAAAAAAAAEFAgQDJZOy0RFUVXN0IRL/xAAXAQEBAQEAAAAAAAAAAAAAAAAEAwUG/8QAHREAAwEAAgMBAAAAAAAAAAAAAAECESEiAzFR8P/aAAwDAQACEQMRAD8A4KRaRiR25aUksOYvaMOQu6aKbjEVNNONUkl/T/F+nQ3T3EZketOMkUkOUtKeSvNerkpSsn5G816uSFOhUNAkikhqlZPyN3r1clKUkvIXetVyHpsTDBJFpDFKSXkLvWq5KlVnF79GJuZCmJhnGSHzCzu/+nE3MGkOmFnV99GJuZp2+y/fDAh8A0ikjaRSRGmIhmki0jEi0iFMVDNJDZVZve++vcwqQ2UWbXnvr3MPT5FQzjpDpdZzffRibmESHSyzi9+jE3M0rfY5+H1BJFpGJFpEaYiGaSLSMSLSIUxUM0kNk1mt5769zCpDJNZrd++vcw9MVDOOkOlVnF79GJuYRIcpOR7+61quTSvd1GB46WYwaRaQtSUh391rVclKRkO+udWrkhTYmGgiRSQtSN/31zq1clKQv+9udWrkhTYmGgqQySWaXfur3MxSF93tzq1cni3VXU6q6nVVU+rbfVtkKYmGf//Z';

/** 解回字节。每次都新解一份 —— 调用方会把它交给上传那台状态机（不共享引用）。 */
export function sampleJpeg(): Uint8Array {
  return fromBase64(SAMPLE_JPEG_B64);
}

