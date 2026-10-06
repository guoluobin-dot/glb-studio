/**
 * 热词替换（渲染层/主进程共用）
 *
 * 为什么单独抽一份：preload 不能 import 渲染层模块（独立上下文），
 * 而这段逻辑又必须与 Hermes 侧 `analyzer/hotwords.js` **逐字一致** ——
 * 不一致就会出现"审阅台改了、字幕没改"这种最难解释的分裂。
 * 抽到 shared 里，两边各自引用同一份语义，测试也能直接锁住行为。
 *
 * @author 郭洛斌
 */

export interface HotwordLike {
  from: string;
  to: string;
}

/**
 * 把文本里听错的词换掉。
 *
 * 两条规则不能省：
 *  - **长的先替**：同时存在「朱老师→朱」和「朱老师老师→朱老师」时，
 *    先替短的会把长词前半段吃掉，结果不可预期。
 *  - **跳过空/同值规则**：用户手滑很容易建出来，留着会让结果难以预期。
 */
export function applyHotwords(text: string, rules: HotwordLike[]): string {
  if (!text) return text ?? "";
  const list = (rules || [])
    .filter((r) => r && typeof r.from === "string" && typeof r.to === "string")
    .filter((r) => r.from.length > 0 && r.from !== r.to)
    .sort((a, b) => b.from.length - a.from.length);
  if (!list.length) return String(text);
  let out = String(text);
  for (const r of list) out = out.split(r.from).join(r.to);
  return out;
}

/** 一条热词在文本里会出现几次（给 UI 做「命中 N 次」） */
export function countHotwordHits(text: string, word: string): number {
  if (!text || !word) return 0;
  return String(text).split(word).length - 1;
}

/**
 * 对整份逐句稿套用热词。
 *
 * 用泛型而不是写死 Transcript：
 * shared 不该反过来依赖 api-types（那会让类型单向依赖变环），
 * 而这里只需要"有一堆带 text 的 segments"，具体类型由调用方带入。
 *
 * 时间戳一律不动：ASR 的时间戳是**句级**的，与句内字数无关，
 * 「猪老师」→「朱老师」字数不变；就算字数变了（「吊」→「钓」），
 * 时间戳仍指向那一句话的起止，字幕对齐不会错。
 */
export function applyHotwordsToTranscript<T extends { segments?: Array<{ text: string }> }>(
  transcript: T | null,
  rules: HotwordLike[]
): T | null {
  if (!transcript?.segments?.length) return transcript;
  const list = (rules || []).filter((r) => r && r.from && r.to);
  if (!list.length) return transcript;
  return {
    ...transcript,
    segments: transcript.segments.map((s) => ({ ...s, text: applyHotwords(String(s.text ?? ""), list) }))
  };
}