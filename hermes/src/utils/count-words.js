/**
 * 数词数：不分配字符串数组。
 *
 * 2026-10-12。
 *
 * 为什么值得单独一个文件：原来的写法是 `text.split(/\s+/).length`（或再叠一个
 * `.filter(Boolean)`），出现在 hit-analyzer 的长稿截断判断和 asr-helper 的
 * chunkTranscript 里。两处都只是拿数字跟阈值比，却各自把**整篇稿子**切成
 * 上万个字符串的数组 —— 单次瞬时内存是全文稿的好几倍，
 * 而长稿动辄几 MB，chunkTranscript 还是每片都切一次。
 *
 * 语义与 `split(/\s+/).filter(Boolean).length` 完全一致：
 * 连续空白算一次分隔，空串算 0 个词。
 */

/**
 * @param {string} text
 * @returns {number} 词数
 */
export function countWords(text) {
  if (!text) return 0;
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // 只认 ASCII 空白（空格 \t \n \v \f \r），和 /\s+/ 在这里的实际行为一致
    const isSpace = c === 32 || (c >= 9 && c <= 13);
    if (isSpace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}