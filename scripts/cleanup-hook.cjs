/**
 * 验证脚本跑完后的清理钩子
 *
 * 为什么需要:verify-opening / verify-wrap / verify-variant-* 都必须走真实的
 * 出片链路才能验证,所以它们会在真实库里建 clip_projects、clip_outputs,
 * 并在 output/draft 下留成片文件。
 *
 * 后果不是"库里多了点垃圾",而是:成片列表按 id 倒序,这些测试记录排在最前面,
 * 用户打开界面看到的第一批全是测试视频 —— 21KB 的那个还是彩条测试图,
 * 看起来像程序坏了。
 *
 * 用法:在验证脚本末尾调 cleanupAfterVerify("<本次涉及的素材名>")
 * 或直接 cleanupAfterVerify() 清掉全部已知测试素材痕迹。
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** 已知测试素材(与 cleanup-test-data.cjs 里的正则保持一致) */
const TEST_SOURCE_RE = /test-live-01|_vo_test|_mv_test|probe_fresh|_verify_slice/i;

const run = (script, ...args) => {
  const full = path.join(__dirname, script);
  try {
    const out = execFileSync(process.execPath, [full, ...args], { encoding: "utf8" });
    return out;
  } catch (err) {
    // 清理失败不该让验证结果变成失败 —— 但要看得见
    console.log(`[cleanup] ${script} 失败: ${String(err.message).slice(0, 200)}`);
    if (err.stdout) console.log(String(err.stdout).slice(-400));
    return null;
  }
};

/**
 * 清理测试痕迹。
 * @param quiet 不打印细节(默认静默,只在出问题时说话)
 */
function cleanupAfterVerify(quiet = true) {
  if (!quiet) console.log("[cleanup] 开始清理测试数据");
  const a = run("cleanup-test-data.cjs", "--apply");
  const b = run("cleanup-draft.cjs", "--apply");
  if (!quiet) {
    console.log("[cleanup] 完成");
  }
  return { db: a !== null, disk: b !== null };
}

/** 只在本次验证涉及的素材名匹配测试素材时清理,避免误删真实数据 */
function cleanupIfTestSource(videoName) {
  if (!TEST_SOURCE_RE.test(String(videoName || ""))) {
    console.log(`[cleanup] 「${videoName}」不是测试素材,跳过清理(真实数据不动)`);
    return { skipped: true };
  }
  return cleanupAfterVerify(true);
}

module.exports = { cleanupAfterVerify, cleanupIfTestSource, TEST_SOURCE_RE };