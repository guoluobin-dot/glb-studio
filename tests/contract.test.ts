/**
 * Hermes 接口契约回归测试
 * © 2026 郭洛斌
 *
 * 为什么要这个文件:两个真实故障都源于"客户端猜的字段名"和"Hermes 实际契约"不一致,
 * 而且都是静默失败(不报错、界面空/候选为 0),靠人工看界面很难第一时间归因。
 * 这里把契约钉死:字段名一改,测试立刻红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * 去掉源码里的注释，只留代码。
 *
 * 断言"某个按钮在哪个位置""某段 className 还剩不存在"时，
 * 必须先剥注释 —— 否则自己写的说明文字会把断言匹配上：
 * 「这个按钮原来在底部（mt-auto 推下去）」这句注释，
 * 正好能让"不该再有 mt-auto"的断言失败。踩过两次，都栽在自己注释上。
 *
 * 两层：
 *   1. TS scanner 剥普通注释
 *   2. 再剥花括号包起来的 JSX 注释 —— 这层 scanner 不管，
 *      因为在 JSX children 里 TS 按文本来处理，只有 AST 知道它是注释
 *
 * 注意别在这个注释里写出「注释的注释」的字面样例 ——
 * 那串标记会当场把这段注释闭合掉，文件直接解析失败。
 * （这坑我自己踩了两次，第二次是在别的文件的注释里。）
 */
const stripComments = (src: string): string => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, src);
  let out = "";
  let last = 0;
  for (;;) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      out += src.slice(last, scanner.getTokenPos());
      last = scanner.getTextPos();
    }
  }
  // 剥 JSX 注释 {/* ... */}，保留花括号免得把表达式结构弄坏
  return (out + src.slice(last)).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "{/* */}");
};

/*
 * 待恢复的验证脚本（2026-10-06 清理误删）
 * ─────────────────────────────────────────────
 * 这 7 个 .cjs 在一次"删掉一次性调试脚本"的清理里被误删，
 * 但它们是 contract.test.ts 大量断言的对象 —— 断言钉的是它们内部的
 * 具体写法（清理逻辑、干跑开关、索引不覆盖等），属于长期回归防线，
 * 不是临时排查工具。
 *
 * 目前这些脚本在 git 历史里也不存在（删除发生在首次提交之前），
 * 无法恢复，所以相关用例用 skipIf 显式跳过：宁可少跑，也不能
 * 假装通过 —— 一旦假装通过，source 侧会显示"已覆盖"，实际无人验证。
 *
 * 恢复方式：按用例里的断言反推脚本内容写回 scripts/，然后把
 * MISSING_SCRIPTS 里对应的名字删掉，用例会立即恢复成正常断言。
 */
const MISSING_SCRIPTS = new Set([
  // 空：2026-10-06 已按断言重建 7 个验证脚本，见 scripts/README-verify.md
]);
const scriptMissing = (name: string): boolean => MISSING_SCRIPTS.has(name);
/** 缺失时返回空串而不是抛 ENOENT —— 配合 skipIf 用，避免整个文件崩掉 */
const readScriptIfPresent = (name: string): string => {
  const fp = join(ROOT, "scripts", name);
  return existsSync(fp) ? readFileSync(fp, "utf8") : "";
};
const readScript = (name: string): string => readFileSync(join(ROOT, "scripts", name), "utf8");
/** 断言"脚本必须存在"的用例用这个：存在就正常跑，缺失就明确跳过 */
const needScript = (name: string) => ({ skipIf: scriptMissing(name) });

// 兼容旧调用点
const E2E_PATH = join(ROOT, "scripts", "verify-compose-e2e.cjs");
const hasE2E = existsSync(E2E_PATH);
const readE2E = (): string => readFileSync(E2E_PATH, "utf8");

describe("preload 桥路径", () => {
  it("主进程配的 preload 文件名必须与 electron-vite 实际产物一致", () => {
    // 只看代码行,排除注释(注释里会写"配成 index.mjs 会失败"这类说明)
    const code = read("src/main/index.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    // 曾经的故障:配 index.mjs,产物是 index.js,桥静默不注入,界面卡在"未连接到主进程"
    expect(code).not.toMatch(/index\.mjs/);
    expect(code).toMatch(/\.\.\/preload\/index\.js/);
  });

  it("打包产物里 preload 目录确实存在 index.js(而非 .mjs)", () => {
    const outPreload = join(ROOT, "out/preload");
    // 未构建时跳过,不能因为没跑 build 就让测试失败
    if (!existsSync(outPreload)) return;
    expect(existsSync(join(outPreload, "index.js"))).toBe(true);
    expect(existsSync(join(outPreload, "index.mjs"))).toBe(false);
  });
});

describe("预览取流", () => {
  const main = read("src/main/index.ts");
  const html = read("src/renderer/index.html");

  it("必须自己实现 Range,不能靠 net.fetch 转发 file://", () => {
    // net.fetch(file://) 会丢掉 Accept-Ranges/Content-Range 并全量读入内存,
    // 结果 3.5 小时素材跳不到中段、且内存爆掉。
    expect(main).not.toMatch(/net\.fetch\(\s*pathToFileURL/);
    expect(main).toMatch(/Content-Range/);
    expect(main).toMatch(/Accept-Ranges/);
    expect(main).toMatch(/206/);
  });

  it("bytes=-N 表示末尾 N 字节,不能把 N 当成 end 再去比 start", () => {
    // 曾经的 bug:bytes=-100 被算成 start=size-100, end=100, 于是 start>end 误回 416
    expect(main).toMatch(/m\[1\]\s*===\s*["']["']/);
    expect(main).toMatch(/start\s*=\s*Math\.max\(0,\s*size\s*-\s*n\)/);
    expect(main).toMatch(/end\s*=\s*size\s*-\s*1/);
  });

  it("协议特权必须含 bypassCSP,否则 Chromium 安全检查拒绝加载", () => {
    expect(main).toMatch(/bypassCSP:\s*true/);
    expect(main).toMatch(/stream:\s*true/);
  });

  it("CSP 的 media-src 必须放行 glb-media:", () => {
    // 协议特权解决 URL 安全检查,CSP 解决渲染进程校验,少一个都是黑屏
    expect(html).toMatch(/media-src[^"]*glb-media:/);
  });

  it("协议必须在 app ready 之前登记", () => {
    const reg = main.indexOf("registerSchemesAsPrivileged");
    const ready = main.indexOf("app.whenReady()");
    expect(reg).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(ready);
  });

  it("必须有白名单:裸注册协议等于让渲染层读任意文件", () => {
    expect(main).toMatch(/allowedMediaFiles/);
    expect(main).toMatch(/allowedMediaFiles\.has\(/);
    expect(main).toMatch(/status:\s*403/);
  });

  it("媒体类型要覆盖常见容器,否则浏览器不知道用什么解码", () => {
    for (const ext of [".mp4", ".mov", ".mkv", ".flv", ".mp3", ".wav"]) {
      expect(main).toContain(`"${ext}"`);
    }
  });
});

describe("逐字逐句裁剪", () => {
  const client = read("src/main/hermes-client.ts");
  const orchestrator = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
  const clipper = readFileSync("D:/GLB/Hermes/src/clipper/index.js", "utf8");

  it("set-selection 必须能接收 cuts,否则界面改的边界会被丢掉", () => {
    expect(orchestrator).toMatch(/cutsByIndex/);
    expect(orchestrator).toMatch(/seg\.cuts\s*=\s*clean/);
    // Clipper 走 cuts 分支才真的按子区间切再拼
    expect(clipper).toMatch(/Array\.isArray\(seg\.cuts\)/);
  });

  it("cuts 必须夹紧到段边界,越界值会让 ffmpeg 切出黑帧", () => {
    expect(orchestrator).toMatch(/st:\s*Math\.max\(seg\.startMs/);
    expect(orchestrator).toMatch(/en:\s*Math\.min\(seg\.endMs/);
    expect(orchestrator).toMatch(/c\.en\s*-\s*c\.st\s*>=\s*200/);
  });

  it("客户端只给真正裁剪过的段传 cuts", () => {
    expect(client).toMatch(/manualCuts.*length\s*>\s*0/);
    expect(client).toMatch(/cutsByIndex\.length\s*>\s*0\s*\?/);
  });

  it("clipped=true 不得提前返回,否则用户勾选被忽略", () => {
    // 曾经的 bug:服务端自动出片后直接 return,用户的勾选根本没写进去
    expect(client).not.toMatch(/if\s*\(created\.clipped\)\s*\{[\s\S]{0,200}?return/);
  });

  it("渲染结果读 clipPaths(真实字段),不是 clips", () => {
    // 曾经读 clips 永远拿到 undefined,界面显示"已输出 0 个文件"
    expect(client).toMatch(/rendered\?\.clipPaths\s*\?\?/);
  });

  it("秒转毫秒不能写反", () => {
    expect(client).toMatch(/Math\.round\(r\.startSec\s*\*\s*1000\)/);
    expect(client).toMatch(/Math\.round\(r\.endSec\s*\*\s*1000\)/);
  });
});

describe("成片包装", () => {
  const client = read("src/main/hermes-client.ts");
  const gen = readFileSync("D:/GLB/Hermes/src/generator/index.js", "utf8");
  const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
  const clipper = readFileSync("D:/GLB/Hermes/src/clipper/index.js", "utf8");
  const sherpa = readFileSync("D:/GLB/Hermes/src/analyzer/sherpa-asr.js", "utf8");

  it("选项必须真的传到 /pipeline/generate(以前 RenderOptions 勾什么都没用)", () => {
    expect(client).toMatch(/"\/pipeline\/generate"/);
    expect(client).toMatch(/subtitles:\s*opts\?\.subtitles\s*!==\s*false/);
    expect(client).toMatch(/covers:\s*opts\?\.covers\s*!==\s*false/);
    expect(orch).toMatch(/contentGenerator\.generateAll\(Number\(projectId\),\s*\{/);
  });

  it("generator 必须按选项跳过步骤,不能无视开关全做", () => {
    expect(gen).toMatch(/if\s*\(opts\.subtitles\)/);
    expect(gen).toMatch(/if\s*\(opts\.covers\)/);
    expect(gen).toMatch(/burnTitle:\s*opts\.title/);
  });

  it("关掉字幕和标题时不该无条件跳过合成", () => {
    // 以前短路条件只有 title/subtitles 两项，于是"关掉字幕标题、但要竖屏/加水印/加 BGM"
    // 会直接跳过合成 —— 那些开关等于白勾。现在短路条件必须覆盖所有会改变画面的开关。
    expect(gen).toMatch(/const needsCompose\s*=/);
    const block = gen.slice(gen.indexOf("const needsCompose"), gen.indexOf("needsCompose") + 600);
    for (const opt of ["opts.title", "opts.subtitles", "opts.coldOpen", "opts.titleCard",
      "opts.watermark", "opts.autoZoom", "opts.bgmPath", "opts.sfx"]) {
      expect(block).toContain(opt);
    }
    // 而且 vertical 也要参与判断
    expect(block).toMatch(/opts\.vertical/);
  });

  it("每个新增开关都要真的改变产物,不能只是改本地状态", () => {
    // 13 个开关以前只有 4 个传到后端,勾了不生效也不报错。
    // 契约只能保证"传过去了",真生效靠 verify-compose 的 28 项实测。
    const cli = read("src/main/hermes-client.ts");
    for (const opt of ["vertical", "captionStyle", "coldOpen", "autoZoom", "watermark", "bgmPath", "sfx"]) {
      expect(cli).toContain(`opts?.${opt}`);
    }
  });

  it("编排层必须把所有开关透传给 generator", () => {
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    const h = orch.slice(orch.indexOf("'/pipeline/generate'"), orch.indexOf("'/pipeline/generate'") + 1800);
    for (const opt of ["vertical", "captionStyle", "coldOpen", "titleCard", "autoZoom",
      "watermark", "bgmPath", "bgmVolume", "duckBgm", "sfx"]) {
      expect(h).toContain(opt);
    }
  });

  it("UI 不得再暴露后端没实现的开关", () => {
    // 假开关比缺功能更糟:用户勾了以为生效,拿到的片子跟没勾一样。
    // 这 6 个后端零实现,已从面板移除(类型里保留为 deprecated 兼容旧存档)。
    const panel = read("src/renderer/src/components/RenderOptions.tsx");
    for (const fake of ['"去废话"', '"智能跳剪"', '"闪回预告"', '"删重录"', '"开场钩子"', '"字幕翻译"']) {
      expect(panel).not.toContain(`label=${fake}`);
    }
    // 真的实现了的要在
    for (const real of ['"竖屏输出"', '"冷开场"', '"自动变焦"', '"音效点缀"']) {
      expect(panel).toContain(`label=${real}`);
    }
    const types = read("src/shared/api-types.ts");
    for (const dep of ["jumpCut?", "cleanFillers?", "cutRetakes?", "flashForward?", "openingHook?", "translate?"]) {
      expect(types).toContain(dep);
    }
  });

  it("getMetadata 的 streams 是数组,读尺寸不能读 meta.stream", () => {
    // 真 bug:读 meta.stream.width(单数)永远取不到,静默落回 1080x1920,
    // 于是 16:9 素材被当成竖屏去裁,输出成 3414x1922 这种畸形比例。
    expect(gen).toMatch(/Array\.isArray\(meta\?\.streams\)/);
    expect(gen).toMatch(/find\(\(s\) => s\.codec_type === 'video'\)/);
    expect(gen).not.toMatch(/meta\?\.stream\?\.width/);
  });

  it("zoompan 的坑必须都绕开", () => {
    // 1) 时间变量是 in_time 不是 t（zoompan 没有 t 这个变量）
    // 2) s= 必须是字面数字，不接受 ih*16/9 这种表达式
    // 3) 多峰值不能用嵌套 if（逗号会被当成滤镜分隔符），改用 between()*累加
    // 4) 且必须排在 crop 之前，否则它的输出尺寸会盖掉裁切结果
    //
    // 注意只查 zoompan 那一段：drawtext 的 enable='between(t,...)' 里 t 是对的，
    // 全局搜 between(t 会误报。锚点用实际代码行，不要用注释（注释里也提到 between(t)。
    const zoomStart = gen.indexOf("const zoomExpr = `1+${terms.join");
    expect(zoomStart).toBeGreaterThan(-1);
    const zoomBlock = gen.slice(zoomStart - 900, zoomStart + 900);
    expect(zoomBlock).toMatch(/between\(in_time,/);
    expect(zoomBlock).not.toMatch(/between\(t,/);
    expect(zoomBlock).toMatch(/zoompan=z=/);
    // 多峰值必须用累加（between(...)*0.12*(...)/...），不能用嵌套 if。
    // 只看代码行——注释里提到过 "if(gte(t,a,lt(t,b))" 这种反例，正则会命中它。
    const codeLines = zoomBlock
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const code = codeLines.join("\n");
    expect(code).not.toMatch(/if\(gte\(/);
    expect(code).not.toMatch(/if\(between\(in_time/);
    expect(code).toMatch(/\)\*0\.12\*/);
    // s= 必须是字面数字：用 w0xh0 而不是 ih*16/9
    expect(zoomBlock).toMatch(/s=\$\{w0\}x\$\{h0\}/);
    // zoompan 排在最前
    expect(gen).toMatch(/\[\.\.\.zoomFilters, \.\.\.filters\]\.join/);
    expect(gen).toMatch(/zoomFilters\.push\(/);
  });

  it("BGM/音效的滤镜标签要逐级更新", () => {
    // 一个标签只能被引用一次。第二次还写固定标签会报
    // "Stream specifier 'amixout' in filtergraph description matches no streams"。
    const sfxStart = gen.indexOf("for (const at of sfxAt)");
    expect(sfxStart).toBeGreaterThan(-1);
    const sfxBlock = gen.slice(sfxStart - 400, sfxStart + 700);
    // label 必须在循环内取（放外面第二次迭代还是 amixout）
    expect(sfxBlock).toMatch(/const label = \(audioOut/);
    expect(sfxBlock).toMatch(/audioOut = `\[amix\$\{ms\}\]`/);
  });

  it("没有 filter_complex 时音频映射必须用原始流", () => {
    // 写 [0:a] 会报 "Output with label '0:a' does not exist in any defined filter graph"
    expect(gen).toMatch(/'-map', audioOut \|\| '0:a:0'/);
  });

  it("字幕为空必须报错,不能静默返回 path:null", () => {
    // 以前只 console.warn 然后回 ok:true,界面"勾了字幕但目录里没文件"
    expect(gen).toMatch(/needsTranscript\s*&&\s*!hasTranscript/);
    expect(gen).toMatch(/totalText:\s*'',\s*error:\s*reason/);
  });

  it("逐句裁剪后字幕时间轴要按 cuts 重算,否则整体偏移", () => {
    expect(gen).toMatch(/segDurationMs/);
    expect(gen).toMatch(/Array\.isArray\(seg\.cuts\)/);
  });

  it("用户已勾选时要跳过自动选段(否则界面选好了也出不了片)", () => {
    // 自动路径的"剔除运营话术"判空会直接 throw,拦死整条流程
    expect(orch).toMatch(/presetSegments/);
    expect(clipper).toMatch(/opts\.presetSegments/);
  });

  it("归一化只有一份实现,两处规则不一致会出现'选了A出了B'", () => {
    expect(orch).toMatch(/_segmentsByIndex/);
    // set-selection 与 clip 的预选路径都要用它
    const uses = (orch.match(/_segmentsByIndex\(/g) || []).length;
    expect(uses).toBeGreaterThanOrEqual(3); // 定义 1 + 两处调用
  });

  it("sherpa-onnx 必须能从 Hermes 自己的 node_modules 加载", () => {
    // 曾经只写死宿主应用里的绝对路径,宿主一重装 ASR 就静默失效
    expect(sherpa).toMatch(/'sherpa-onnx-node\/sherpa-onnx\.js'/);
    // 包名不是文件系统路径,必须用 require.resolve 而非 existsSync
    expect(sherpa).toMatch(/_require\.resolve\(p\)/);
  });

  it("切片长度必须 <= 15 秒,否则转写全空", () => {
    // 实测:sense-voice 在 16kHz 下窗口上限约 15 秒。
    //   14s 有结果("爸爸"),16s 起恒为空串,20s/30s 分块必然踩线。
    // 后果:所有 >20s 的素材转写为空,报"No ASR transcript available",
    // 而音频其实有声(-14dB)。整条爆款素材因此进不了记忆库。
    const m = sherpa.match(/const CHUNK_SECONDS = (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(15);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(5);
  });

  it("worker 的兜底切片长度必须同样 <= 15 秒", () => {
    // 曾写 || 60,主线程那次导入一旦失败就静默退回 60s 分块,
    // 正好踩上限,整场转写全空且无任何报错。
    const worker = readFileSync("D:/GLB/Hermes/src/analyzer/sherpa-worker.js", "utf8");
    const m = worker.match(/const CHUNK_SECONDS = SHERPA_CHUNK_SECONDS \|\| (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(15);
  });
});

describe("启动脚本可靠性", () => {
  const start = readFileSync("D:/GLB/start-glb.cmd", "utf8");

  it("必须在界面就绪检查之前拉起 Ollama 与 Hermes", () => {
    // 曾经的 bug:"已在运行"分支直接 exit,导致只有界面活着、服务全挂,
    // 表现是能打开但什么都做不了
    const guardIdx = start.indexOf("hermes-guard");
    const firstCheck = start.indexOf('tasklist /fi "imagename eq GLB Studio.exe"');
    const ollamaIdx = start.indexOf("Ollama\\ollama.exe");
    expect(ollamaIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstCheck).toBeGreaterThan(-1);
    // 第一个 tasklist(幂等检查)必须晚于服务启动语句
    expect(ollamaIdx).toBeLessThan(firstCheck);
    expect(guardIdx).toBeLessThan(firstCheck);
  });

  it("必须等两个服务都就绪才算 ready", () => {
    expect(start).toMatch(/11434\/api\/tags/);
    expect(start).toMatch(/%HERMES_PORT%\/health/);
  });

  it("脚本必须纯 ASCII(控制台代码页是 GBK,中文注释会破坏解析)", () => {
    const bad = start.split("\n").filter((l) => Buffer.from(l, "utf8").some((b) => b > 127));
    expect(bad).toEqual([]);
  });

  it("守护脚本必须语法正确(改坏过,残留大括号导致静默不启动)", () => {
    const guard = readFileSync("D:/GLB/hermes-guard.js", "utf8");
    // 括号配平:这是最廉价的语法自检,能挡住手滑残留
    const open = (guard.match(/\{/g) || []).length;
    const close = (guard.match(/\}/g) || []).length;
    expect(open).toBe(close);
  });
});

describe("主题分类污染", () => {
  const analyzer = readFileSync("D:/GLB/Hermes/src/analyzer/live-analyzer.js", "utf8");

  it("提示词不得把'指定开头'当主题教给模型", () => {
    // 原写法要求 theme_name 就写这四个字 + hook 给 0.95,
    // 结果同一句被切成 6~10 段,主题库被这四个字挤占
    expect(analyzer).not.toMatch(/theme_name 写"指定开头"/);
    expect(analyzer).toMatch(/创作约束 · 不是主题/);
  });

  it("必须限制指定开头只切一段,防重复污染", () => {
    expect(analyzer).toMatch(/全场最多切这一段/);
    expect(analyzer).toMatch(/近似表述.*不算命中/);
  });

  it("钩子分不得强制 0.95,否则压过真实教学爆点", () => {
    // 只看提示词块(注释里提到旧值是正常的说明,不该让测试误红)
    const start = analyzer.indexOf('function buildSegmentSystemPrompt');
    const end = analyzer.indexOf('\nexport class', start);
    const promptSrc = analyzer.slice(start, end > start ? end : undefined);
    expect(promptSrc).not.toMatch(/hook_quality 给 0\.95/);
    expect(promptSrc).toMatch(/hook_quality 给 0\.8/);
  });

  it("弃段意见里的标题不得被当成指定开头", () => {
    // 真实数据:[桌面端弃段·某老师]《标题》… 这类带《》但不是创作指令
    expect(analyzer).toMatch(/if\s*\(!\/指定开头\/\.test\(f\)\)\s*continue/);
  });

  it("撤销类指令要识别,但不能误伤'指定+重剪'", () => {
    // [桌面端打回]…：指定新开头重找        ← 撤销
    // [桌面端指定开头]…；指定新开头重找    ← 这条本身是指定,"重找"指重剪
    // 一刀切过滤会让真指令一起失效
    expect(analyzer).toMatch(/桌面端打回/);
    expect(analyzer).toMatch(/isRevocation/);
  });

  it("必须有入库前清洗(不能只靠提示词)", () => {
    expect(analyzer).toMatch(/_sanitizeSegments/);
    expect(analyzer).toMatch(/theme_name = '待分类'/);
    expect(analyzer).toMatch(/Math\.min\(Number\(keep\.hook_quality\) \|\| 0\.8, 0\.8\)/);
    expect(analyzer).toMatch(/removedDuplicateOpeningSegments/);
  });

  it("清洗必须在写库之前调用", () => {
    const sanitize = analyzer.indexOf('this._sanitizeSegments(allSegments');
    const store = analyzer.indexOf('this.store.addLiveSegment');
    expect(sanitize).toBeGreaterThan(-1);
    expect(store).toBeGreaterThan(-1);
    expect(sanitize).toBeLessThan(store);
  });

  it("旧分段必须在分析全部完成后才清(先算后写)", () => {
    // 分析要跑 30~60 分钟,先 DELETE 再跑的话,中途失败/被杀就永久丢数据。
    // 我们已经因此丢过一次 209 段。
    expect(analyzer).toMatch(/purgeOldSegments/);
    const purge = analyzer.indexOf('if (allSegments.length > 0) purgeOldSegments();');
    const store = analyzer.indexOf('this.store.addLiveSegment');
    expect(purge).toBeGreaterThan(-1);
    expect(purge).toBeLessThan(store);
    // 旧 DELETE 语句只能存在于 purgeOldSegments 内部
    const del = analyzer.indexOf("DELETE FROM live_segments WHERE live_video_id = ?");
    const fnStart = analyzer.indexOf('const purgeOldSegments = () => {');
    expect(del).toBeGreaterThan(fnStart);
  });
});

describe("LLM 可用性", () => {
  const ollama = readFileSync("D:/GLB/Hermes/src/llm/ollama.js", "utf8");
  const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");

  it("视觉调用必须关掉 thinking,否则 content 恒为空", () => {
    // qwen3 默认开 thinking,输出全在 thinking 字段。
    // 曾经只在一处设了 think:false,视觉调用漏了。
    const vision = ollama.slice(ollama.indexOf("images }]"), ollama.indexOf("images }]") + 600);
    expect(vision).toMatch(/think:\s*false/);
  });

  it("CUDA OOM 必须自动释放显存并重试", () => {
    // 十几个僵尸 llama-server 吃满 8GB 显存,之后每个请求都 OOM,
    // 而 health 仍显示正常 —— 表现为"模型装了却一直失败"
    expect(ollama).toMatch(/out of memory/);
    expect(ollama).toMatch(/_unloadAll/);
    expect(ollama).toMatch(/keep_alive:\s*0/);
  });

  it("keep_alive 不能太长(超时/取消会留下没回收的进程)", () => {
    expect(ollama).not.toMatch(/keep_alive:\s*'10m'/);
  });

  it("LLM 连通性必须持续复查,不能只在启动时探一次", () => {
    // 启动脚本里 Ollama 与 Hermes 同时拉起,Hermes 常先就绪、5s 探���直接判失败,
    // ollamaReady 永久为 false,界面一直显示"算力未就绪"
    expect(orch).toMatch(/_startLlmWatch/);
    expect(orch).toMatch(/15_000/);
  });
});

describe("爆款开头前置", () => {
  const clipper = readFileSync("D:/GLB/Hermes/src/clipper/index.js", "utf8");
  const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
  const client = read("src/main/hermes-client.ts");
  const opts = read("src/renderer/src/components/RenderOptions.tsx");

  it("必须从全场挑,而不是只在用户勾选的段里排序", () => {
    // 这才是"前置":用户没勾的那段也可能成为片头
    expect(clipper).toMatch(/_planViralOpening/);
    expect(clipper).toMatch(/allSegments/);
    expect(clipper).toMatch(/全场钩子分最高/);
  });

  it("指定开头优先级最高,且找不到就不前置(不硬塞)", () => {
    expect(clipper).toMatch(/命中指定开头/);
    expect(clipper).toMatch(/没有值得前置的段落/);
  });

  it("运营话术段绝不能当开头", () => {
    expect(clipper).toMatch(/_isOperationHeavySegment/);
  });

  it("片头必须按长度裁剪,不能把整段放片头", () => {
    // 注意:文件里 _planViralOpening 有定义处和调用处,
    // indexOf 会命中调用处,必须用 lastIndexOf 拿定义那段
    const start = clipper.lastIndexOf('_planViralOpening');
    const fn = clipper.slice(start, start + 4500);
    expect(start).toBeGreaterThan(0);
    // 用 cuts 表达"只取开头这么多秒",而不是改 start/end
    expect(fn).toMatch(/\[\{ st: s0, en: s0 \+ takeMs \}\]/);
    expect(fn).toMatch(/开头可用长度不足 3 秒/);
  });

  it("同一段不能既当前置又留在正文里(会出现两遍)", () => {
    expect(clipper).toMatch(/picked\.splice\(i, 1\)/);
  });

  it("用户勾选路径与自动路径行为必须一致", () => {
    // 只在自动路径加前置、用户勾选没有,是最容易被漏的不一致
    const presetIdx = clipper.indexOf('opts.presetSegments');
    const autoIdx = clipper.indexOf('const openingPlan = this._planViralOpening');
    expect(clipper.indexOf('_planViralOpening', presetIdx)).toBeGreaterThan(presetIdx);
    expect(clipper.indexOf('_planViralOpening', autoIdx)).toBeGreaterThan(autoIdx);
  });

  it("端点必须透传开关与指定原文", () => {
    expect(orch).toMatch(/viralOpening: req\.body\.viralOpening !== false/);
    expect(orch).toMatch(/openingText: req\.body\.openingText/);
    expect(orch).toMatch(/viralOpeningSeconds/);
  });

  it("客户端与界面都要能配", () => {
    expect(client).toMatch(/viralOpening: request_\.options\.viralOpening/);
    expect(opts).toMatch(/爆款开头前置/);
    expect(opts).toMatch(/viralOpeningSeconds/);
    expect(opts).toMatch(/指定开头原文/);
  });

  it("结果要带回给用户,否则他不知道片头被改动了", () => {
    expect(client).toMatch(/viralOpening: created\.viralOpening/);
    expect(read("src/renderer/src/components/Workbench.tsx")).toMatch(/开头已前置/);
  });
});

describe("界面稳定性", () => {
  const app = read("src/renderer/src/App.tsx");
  const wb = read("src/renderer/src/components/Workbench.tsx");

  it("轮询不得无条件 setState(会重渲染整棵树,表现为界面闪烁)", () => {
    // 15s 轮询本地栈,每次 setStack(新对象) 会让正在播放的 <video>、
    // 候选卡、滚动位置全部重建
    expect(app).toMatch(/sameStack/);
    expect(app).toMatch(/setStack\(\(prev\)/);
    expect(app).not.toMatch(/if \(alive\) setStack\(\{ status, loading: false \}\)/);
  });

  it("比较函数必须真的比较内容,不能只比引用", () => {
    expect(app).toMatch(/a\.hermes\.ok !== b\.hermes\.ok/);
    expect(app).toMatch(/a\.ollama\.models\.length !== b\.ollama\.models\.length/);
  });

  it("长任务必须显示已用时间(否则用户以为卡死,反复点按钮)", () => {
    expect(wb).toMatch(/elapsedSec/);
    expect(wb).toMatch(/formatElapsed/);
    // 以前是 elapsedSec={elapsed()}：那需要每秒 setTick 强制整树重渲染。
    // 现在计时搬进 ElapsedBadge，只有那几行文字重渲染。
    expect(wb).toMatch(/<ElapsedBadge running=\{elapsedRunning\} \/>/);
    expect(wb).toMatch(/function ElapsedBadge/);
  });

  it("计时器不能拖垮整个工作区", () => {
    // 真实卡顿：Workbench 1500+ 行，每秒 setTick 一次强制整树重渲染，
    // 而树里有 1772 句逐句稿（真实 DOM）+ 全部候选卡。
    // 分析一场 3 小时直播要几十分钟 = 界面卡几十分钟。
    // 现在：逐句稿虚拟化 + 计时独立组件 + 当前句二分查找。
    // 只查真实调用，注释里提到 setTick 不算
    expect(wb, "setTick 每秒强制整树重渲染").not.toMatch(/setTick\(\(n\)/);
    expect(wb, "elapsed() 每次 render 都读 Date.now，必须消掉").not.toMatch(/=\{formatElapsed\(elapsed\(\)\)\}/);

    const panel = read("src/renderer/src/components/TranscriptPanel.tsx");
    expect(panel).toMatch(/<WindowedList/);
    // 跟随播放不能依赖"该行已渲染"——虚拟化下它常常不在 DOM 里。
    // 只查真实引用（ref={active ? activeRef : undefined}），注释里提到不算。
    expect(panel, "跟随播放仍在用 activeRef，虚拟化后会静默失效").not.toMatch(/activeRef\.current/);
    expect(panel).not.toMatch(/ref=\{active \? activeRef/);
    // 当前句必须是二分，不能每次 currentTime 更新都全量扫 1772 句
    expect(panel).toMatch(/function findActiveIndex/);
    expect(panel).not.toMatch(/segments\.reduce\(\(acc, seg, i\)/);

    const win = read("src/renderer/src/components/WindowedList.tsx");
    expect(win).toMatch(/只渲染可视区/);
    // 搜索态命中项必须可见，否则用户以为高亮丢了
    expect(panel).toMatch(/const listItems = hitIds \? matches \?\? \[\] : segments/);
  });

  it("分析期间工作区要保持可用,不能整屏只剩进度面板", () => {
    // 真实 bug：条件是 `error ? ... : transcribing || detecting ? <TaskPanel/> : <工作区>`，
    // 于是分析一启动整屏只剩 TaskPanel，播放器/时间轴/逐句稿全消失；
    // 而"分析中的悬浮条"写在 else 分支里，永远渲染不到。
    // 注释描述的设计和代码实际行为相反。
    expect(wb).not.toMatch(/\(\) : transcribing \|\| detecting \?/);
    expect(wb).toMatch(/error && !file \?/);
    expect(wb).toMatch(/void cancelDetect\(\)/);
    // 失败提示也不能顶掉工作区
    expect(wb).toMatch(/这一步没跑完/);
  });

  it("取消必须真的取消", () => {
    // 真实 bug：「取消」按钮调的是 runDetect()，也就是"重新分析一遍"。
    // 文案和行为相反，而且服务端还在对同一个 videoPath 跑着，
    // 要么撞 409「正在分析中」，要么两份分析并发跑、各自删分段互相覆盖。
    expect(wb).toMatch(/api\.cancelDetect\(file\.path\)/);
    expect(wb, "取消按钮还在调 runDetect").not.toMatch(/onClick=\{\(\) => void runDetect\(\)\}[\s\S]{0,60}取消/);
    // 取消后迟到的结果不能覆盖界面
    expect(wb).toMatch(/if \(cancelledRef\.current\) return;/);
    const api = read("src/shared/api-types.ts");
    expect(api).toMatch(/cancelDetect\(filePath: string\)/);

    const h = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    expect(h).toMatch(/app\.post\('\/pipeline\/analyze-cancel'/);
    expect(h).toMatch(/this\._liveAbort\.set\(key, ctl\)/);
    const an = readFileSync("D:/GLB/Hermes/src/analyzer/live-analyzer.js", "utf8");
    expect(an, "analyze 不认 signal，取消等于没发生").toMatch(/throwIfAborted/);
    // 取消不能算失败，否则会被调度器重新排队白跑一遍
    expect(an).toMatch(/err\?\.userCancelled/);
    expect(an).toMatch(/health\.grade = 'cancelled'/);
  });

  it("长任务必须说明阶段与耗时量级", () => {
    expect(wb).toMatch(/TRANSCIBE_STEPS/);
    expect(wb).toMatch(/DETECT_STEPS/);
    expect(wb).toMatch(/约 5 分钟/);
  });

  it("计时器必须在任务结束时清掉,不能泄漏", () => {
    expect(wb).toMatch(/clearInterval\(id\)/);
  });
});

describe("多版本粗剪", () => {
  const clipper = readFileSync("D:/GLB/Hermes/src/clipper/index.js", "utf8");
  const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
  const panel = read("src/renderer/src/components/VariantPanel.tsx");

  it("必须有端点,否则界面调不到", () => {
    expect(orch).toMatch(/'\/pipeline\/clip-variants'/);
    expect(clipper).toMatch(/clipVariants/);
  });

  it("每版必须建独立工程(共用工程会互相覆盖选段)", () => {
    // _trimToTargetDuration 会增删段,共用工程第 2 版就把第 1 版改了
    expect(clipper).toMatch(/createProject\(liveVideoId,\s*\{[\s\S]{0,200}presetSegments: picked/);
    // 每版结果要带上自己的 projectId,才能追溯是哪一版
    expect(clipper).toMatch(/projectId: built\.projectId/);
  });

  it("补段池不能传空数组(否则'时长不足自动补足'永远失效)", () => {
    // 传 [] 时 8 分钟档只出 4 分钟内容,多版本退化成"其实没区别"
    expect(clipper).not.toMatch(/pool:\s*\[\]/);
    expect(clipper).toMatch(/pool/);
  });

  it("补进来的段必须归一化字段名,否则那一片是空的", () => {
    // live_segments 是 start_ms/theme_name,Clipper 读 startMs/themeName
    expect(clipper).toMatch(/startMs:\s*Number\(s\.startMs\s*\?\?\s*s\.start_ms/);
    expect(clipper).toMatch(/themeName:\s*s\.theme_name\s*\?\?\s*s\.themeName/);
  });

  it("时长字段名必须带 Ms,否则界面显示 68000 秒", () => {
    // 在多处调用的场景里,字段名没有单位区分度
    expect(clipper).toMatch(/totalDurationMs/);
    // 2026-10-05：clip() 的返回值扩成了对象字面量（多了 roughcutFailed / error），
    // 这条断言原来锁的是 `return { clipPaths, roughcutPath, totalDurationMs }` 这一行文本，
    // 于是自己把自己判成了失败。改成锁真正的契约：字段名 + 不得出现无单位的别名。
    expect(clipper).not.toMatch(/totalDuration: totalDuration/);
    // 拼接失败必须能被调用方看见
    expect(clipper).toMatch(/roughcutFailed/);
  });

  it("指定开头版没有原文时必须跳过(否则和标准版无区别)", () => {
    expect(clipper).toMatch(/没有指定开头原文,已跳过该版本/);
  });

  it("单个版本失败不能让整批失败", () => {
    expect(clipper).toMatch(/ok:\s*false,\s*\n\s*files:\s*\[\],\s*\n\s*error: err\.message/);
    expect(clipper).toMatch(/多版本粗剪完成/);
  });

  it("界面要显示各版实际时长,否则用户无法判断有没有区别", () => {
    expect(panel).toMatch(/totalSec/);
    expect(panel).toMatch(/选这版/);
    // 未勾选原文时禁用该版本
    expect(panel).toMatch(/needOpening/);
  });
});

describe("出片产物可预览可打开", () => {
  const main = read("src/main/index.ts");
  const preload = read("src/preload/index.ts");
  const types = read("src/shared/api-types.ts");
  const dock = read("src/renderer/src/components/ExportDock.tsx");
  const wb = read("src/renderer/src/components/Workbench.tsx");
  const list = read("src/renderer/src/components/ResultList.tsx");

  it("必须有三个通道,否则产物点了没反应", () => {
    // 主进程/preload 用通道名,类型声明用方法名,两者要分别断言
    for (const ch of ["result:reveal", "result:openExternal", "result:openFolder"]) {
      expect(main).toContain(ch);
      expect(preload).toContain(ch);
    }
    for (const m of ["revealResult", "openResultExternal", "openResultFolder"]) {
      expect(types).toContain(m);
    }
  });

  it("打开产物必须按扩展名白名单(否则等于开了任意程序执行)", () => {
    // shell.openPath 交给系统执行。渲染层能传任意路径,
    // 不挡 .exe/.bat/.ps1 就是给渲染层一个远程执行的口子。
    expect(main).toMatch(/RESULT_EXT = new Set/);
    expect(main).toMatch(/\.mp4/);
    expect(main).toMatch(/if \(!RESULT_EXT\.has\(ext\)\) return null/);
    expect(main).toMatch(/if \(!existsSync\(abs\)\) return null/);
  });

  it("openPath / showItemInFolder 是异步的,必须 await", () => {
    // 不 await 就返回 ok:true,界面以为成功了,实际可能什么都没发生。
    // 这是真实踩过的坑:verify-results 拿到的 ok 是个 Promise。
    expect(main).toMatch(/await\s+shell\.openPath\(abs\)/);
    expect(main).toMatch(/await\s+shell\.showItemInFolder\(abs\)/);
  });

  it("验证脚本不许真的弹播放器(必须支持干跑)", () => {
    // 真实事故:verify:results 调 openResultExternal 真去开系统默认播放器,
    // 打开的还�� output 目录里一个早期遗留的 21KB 测试彩条,
    // 用户满屏彩条,还以为程序坏了。验证脚本必须有副作用豁免开关。
    for (const ch of ['handle("result:reveal"', 'handle("result:openExternal"', 'handle("result:openFolder"']) {
      const fn = main.slice(main.indexOf(ch));
      expect(fn.slice(0, 600)).toMatch(/GLB_NO_OPEN === "1"/);
    }
    const script = readScriptIfPresent("verify-results.cjs");
    expect(script).toMatch(/process\.env\.GLB_NO_OPEN = "1"/);
    // 干跑模式下白名单校验不能被跳过
    expect(script).toMatch(/干跑下仍拒绝可执行文件/);
  });

  it("目录通道必须校验是目录,不能是文件", () => {
    expect(main).toMatch(/isDirectory\(\)/);
  });

  it("出片成功要把产物存下来给面板用", () => {
    expect(wb).toMatch(/const \[artifacts, setArtifacts\] = useState<ExportArtifacts \| null>/);
    expect(wb).toMatch(/setArtifacts\(\s*\n\s*result\.files\.length > 0/);
    // 失败时要清掉上一次的产物,否则面板上留着一份已经不存在的清单
    const failBranch = wb.slice(wb.indexOf("出片失败"));
    expect(failBranch).toMatch(/setArtifacts\(null\)/);
  });

  it("产物面板要按类型分组,并提供预览/打开/定位", () => {
    expect(list).toMatch(/function kindOf/);
    expect(list).toMatch(/打开输出文件夹/);
    expect(list).toMatch(/在资源管理器中定位/);
    expect(list).toMatch(/用系统播放器打开/);
    expect(list).toMatch(/预览成片/);
    // 成片可点开在应用内看,这是"出完片还要自己去翻目录"的解法
    expect(list).toMatch(/setPreview\(f\)/);
    expect(list).toMatch(/<PreviewPlayer filePath=\{preview\}/);
  });

  it("预览成片要自动播,且高度固定(不能撑满整列)", () => {
    expect(list).toMatch(/autoPlay/);
    expect(list).toMatch(/heightClass="h-\[52vh\]/);
  });

  it("PreviewPlayer 的回调必须可选(否则预览成片无法复用)", () => {
    // 以前全是必填,复用就得塞一堆假回调
    const pp = read("src/renderer/src/components/PreviewPlayer.tsx");
    expect(pp).toMatch(/onTime\?: \(sec: number\) => void/);
    expect(pp).toMatch(/registerApi\?: \(api: PlaybackApi \| null\) => void/);
    expect(pp).toMatch(/onTime\?\.\(t\)/);
    expect(pp).toMatch(/if \(!registerApi\) return/);
  });
});

describe("主题切换", () => {
  const hook = read("src/renderer/src/hooks/useTheme.ts");
  const wb = read("src/renderer/src/components/Workbench.tsx");

  it("必须用 CSS 变量而不是改组件", () => {
    // 改组件的话换主题要重编译,而且总有漏改的地方
    expect(read("src/renderer/src/styles.css")).toMatch(/\[data-theme="light"\]/);
    expect(hook).toMatch(/setAttribute\("data-theme", "light"\)/);
    expect(hook).toMatch(/removeAttribute\("data-theme"\)/);
  });

  it("必须持久化,且首屏同步读取(否则闪一下默认色)", () => {
    expect(hook).toMatch(/localStorage\.setItem/);
    // 异步读会闪;同步读保证第一帧就对
    expect(hook).toMatch(/function readInitial\(\)/);
    expect(hook).not.toMatch(/await.*localStorage|localStorage.*await/);
  });

  it("首次使用要跟随系统", () => {
    // 用户系统是浅色的却默认深色会很突兀
    expect(hook).toMatch(/prefers-color-scheme: light/);
  });

  it("存储不可用时不能崩(隐私模式)", () => {
    expect(hook).toMatch(/catch/);
  });

  it("按钮要有切换说明(用户不知道图标是什么)", () => {
    expect(wb).toMatch(/切到浅色|切到深色/);
    expect(wb).toMatch(/LuSun|LuMoon/);
  });

  it("主题不放在 session-store 里", () => {
    // session-store 是"剪辑会话"(素材/候选/勾选),
    // 主题是应用偏好。混在一起会被 reset() 一起清掉。
    const store = read("src/renderer/src/stores/session-store.ts");
    expect(store).not.toMatch(/theme/);
  });
});

describe("出片预设不许偷偷勾假开关", () => {
  const ro = read("src/renderer/src/components/RenderOptions.tsx");

  it("预设里不能出现后端没实现的开关", () => {
    // 这个坑比 UI 上的假开关更隐蔽:UI 已经删干净了,但预设里还写着
    // jumpCut: true / cleanFillers: true —— 用户点一下"带货短视频",
    // 拿到的片子跟没点一样,而提示语还写着"去废话"。
    const presetBlock = ro.slice(ro.indexOf("export const PRESETS"), ro.indexOf("interface ToggleProps"));
    for (const fake of ["jumpCut", "cleanFillers", "cutRetakes", "openingHook", "flashForward", "translate"]) {
      expect(presetBlock, `预设里不该出现未实现的 ${fake}`).not.toMatch(new RegExp(`${fake}\\s*:`));
    }
  });

  it("预设提示语不能说没实现的效果", () => {
    const presetBlock = ro.slice(ro.indexOf("export const PRESETS"), ro.indexOf("interface ToggleProps"));
    // 只看 hint: 行,别把源码注释一起判了 —— 注释里本来就要写清楚
    // "以前这里假开关是什么",那正是这个测试存在的意义。
    const hints = [...presetBlock.matchAll(/hint:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThanOrEqual(3);
    for (const h of hints) {
      expect(h, `预设提示语不该承诺没实现的效果: ${h}`).not.toMatch(/去废话|智能跳剪|闪前预告|删重录|字幕翻译/);
    }
  });

  it("预设只能用 DEFAULT_RENDER 里的真实字段", () => {
    // 拿 DEFAULT_RENDER 的字段名当白名单,新增假字段时测试会立刻炸
    const defBlock = ro.slice(ro.indexOf("export const DEFAULT_RENDER"), ro.indexOf("export const PRESETS"));
    const allowed = new Set(
      [...defBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*[:,]/gm)].map((m) => m[1])
    );
    expect(allowed.size).toBeGreaterThan(5);
    const presetBlock = ro.slice(ro.indexOf("export const PRESETS"), ro.indexOf("interface ToggleProps"));
    for (const m of presetBlock.matchAll(/^\s{6}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)) {
      expect(allowed.has(m[1]), `预设字段 ${m[1]} 不在 DEFAULT_RENDER 里`).toBe(true);
    }
  });
});

describe("直播素材 ↔ IP 记忆绑定", () => {
  const store = read("../../GLB/Hermes/src/memory/store.js");
  const analyzer = read("../../GLB/Hermes/src/analyzer/live-analyzer.js");
  const orch = read("../../GLB/Hermes/src/orchestrator/index.js");
  const client = read("src/main/hermes-client.ts");

  // 行为级测试在 Hermes 侧（src/memory/__tests__/live-ip-binding.test.mjs），
  // 因为它的 better-sqlite3 按 Hermes 自带 node 的 ABI 编译，
  // 放进这里的 vitest 会在 import 阶段就崩。这里只守住"链路没被拆掉"。

  it("绑定关系要落在素材自己身上,不能靠全局当前选中", () => {
    // 以前只看 store.activeCollection：导入案例老师的直播时界面停在王老师身上，
    // 就会用王老师的记忆分析案例老师的素材 —— 不报错,只是结果不对味。
    expect(store).toMatch(/collection TEXT/);
    expect(store).toMatch(/getLiveVideoCollection/);
    expect(store).toMatch(/bindLiveVideoCollection/);
  });

  it("分析时必须读这条直播的归属,而不是硬读全局", () => {
    expect(analyzer).toMatch(/buildMemoryContext\(this\.store,\s*ownCollection\)/);
    expect(analyzer).toMatch(/getLiveVideoCollection\?\.\(liveVideoId\)/);
    // 旧的硬编码写法不能再出现
    expect(analyzer).not.toMatch(/const mem = buildMemoryContext\(this\.store\);/);
  });

  it("buildMemoryContext 要能收归属,且不传时保持旧行为", () => {
    // 老调用方只传一个参数，必须还能用 —— 否则一改就到处炸
    expect(analyzer).toMatch(/function buildMemoryContext\(store, collection = undefined\)/);
    expect(analyzer).toMatch(/collection !== undefined/);
  });

  it("补列必须在建表之后,否则新装机器缺列", () => {
    // 这是个真实踩过的坑：ALTER 写在 _init() 之前，全新库里表还不存在，
    // ALTER 被 catch 吞掉，第一次 INSERT 就报 no such column。
    // 比较的是构造函数里两个**调用**的先后，不是方法定义的位置。
    const initAt = store.indexOf("this._init();");
    const alterAt = store.indexOf("this._addMissingColumns();");
    expect(initAt, "构造函数里应有 this._init()").toBeGreaterThan(-1);
    expect(alterAt, "构造函数里应有 this._addMissingColumns()").toBeGreaterThan(-1);
    expect(alterAt, "补列必须排在建表之后").toBeGreaterThan(initAt);
    // 新库靠 CREATE TABLE 声明，老库靠 ALTER 补，两处都要有
    expect(store).toMatch(/CREATE TABLE IF NOT EXISTS live_videos[\s\S]*analysis_health TEXT/);
    expect(store).toMatch(/CREATE TABLE IF NOT EXISTS live_videos[\s\S]*collection TEXT/);
    // 补列逻辑必须真的存在于该方法里
    expect(store).toMatch(/_addMissingColumns\(\)\s*\{[\s\S]*ALTER TABLE live_videos ADD COLUMN collection/);
  });

  it("分析入口要能收 collection 并先绑定再分析", () => {
    // 顺序反了就只能用全局兜底，等于没绑
    expect(orch).toMatch(/req\.body\?\.collection/);
    const bind = orch.indexOf("bindLiveVideoCollection(vid, collection)");
    const analyze = orch.indexOf("await this.liveAnalyzer.analyze(videoPath,");
    expect(bind, "找不到绑定调用").toBeGreaterThan(-1);
    // 调用现在多了第二个参数 { signal }，只匹配前半个名字会返回 -1，
    // 而 `bind < -1` 恒真 —— 断言会静默失效，等于没测
    expect(analyze, "找不到 analyze 调用").toBeGreaterThan(-1);
    expect(bind, "必须先绑定 collection 再分析，否则分析读不到当次选的记忆库").toBeLessThan(analyze);
  });

  it("中途 upsert 不能把绑定冲掉", () => {
    // 分析会 upsert 好几次（analyzing/分段数/体检），都不带 collection
    expect(store).toMatch(/collection: data\.collection !== undefined && data\.collection !== null/);
    expect(store).toMatch(/collection = @collection/);
  });
});

describe("IP 选择器在上传直播上面", () => {
  const imp = read("src/renderer/src/components/ImportStage.tsx");
  const picker = read("src/renderer/src/components/IpPicker.tsx");
  const store = read("src/renderer/src/stores/session-store.ts");
  const wb = read("src/renderer/src/components/Workbench.tsx");
  const client = read("src/main/hermes-client.ts");

  it("选择器必须排在拖拽区之前", () => {
    // 顺序有讲究：先说清归谁的记忆，再收素材。反过来的话用户已经把素材
    // 交出去了才发现用错爆款库,而那个错不报错。
    expect(imp).toMatch(/IpPicker/);
    const pickerAt = imp.indexOf("<IpPicker");
    const dropAt = imp.indexOf("drop-zone");
    expect(pickerAt, "IpPicker 应在 drop-zone 之前").toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(-1);
    expect(pickerAt).toBeLessThan(dropAt);
  });

  it("归属要跟着素材存进会话,不能只在组件局部", () => {
    // 存在组件里的值在用户切到别的界面后就丢了,
    // 而分析恰恰发生在切走之后。
    expect(store).toMatch(/collection: string \| null/);
    expect(store).toMatch(/setCollection/);
    expect(store).toMatch(/collection: opts\?\.collection \?\? null/);
  });

  it("分析请求必须带上归属", () => {
    // detect 的调用现在是多行对象，断言要跟着改 ——
    // 单行匹配会在无害的格式化变动上误报，久了就没人看这个测试了
    expect(wb).toMatch(/api\.detect\(\{[\s\S]*?collection: session\.collection/);
    expect(client).toMatch(/collection: request_\.collection/);
  });

  it("只有一个老师时自动选上", () => {
    // 绝大多数用户就一位老师,每次手选一遍纯属多余步骤
    expect(picker).toMatch(/list\.length === 1/);
  });

  it("选中后要同步给 Hermes,不能只停在界面", () => {
    // 不调 hitActivateIp 的话,评审经验和避雷词仍会串到别的老师
    expect(picker).toMatch(/hitActivateIp/);
  });

  it("换素材时归属要跟着重置", () => {
    // 否则上一条素材的 IP 会悄悄贴到新素材上
    expect(store).toMatch(/\.\.\.EMPTY,[\s\S]*collection: opts\?\.collection \?\? null/);
    // EMPTY 里的默认值必须是 null（用通用记忆），不能是残留值
    const emptyBlock = store.slice(store.indexOf("const EMPTY"), store.indexOf("const EMPTY") + 600);
    expect(emptyBlock).toMatch(/collection: null as string \| null/);
  });
});

describe("拖拽导入", () => {
  const preload = read("src/preload/index.ts");
  const imp = read("src/renderer/src/components/ImportStage.tsx");
  const types = read("src/shared/api-types.ts");

  it("必须用 webUtils 取路径,不能读 File.path", () => {
    // Electron 32 起 File.path 被移除，渲染层拿到的 File 只有 name/size/type。
    // 旧代码 `f.path` 恒为 undefined，整个拖拽分支被过滤空 ——
    // 表现为"拖进来完全没反应"且不报错。
    expect(preload).toMatch(/webUtils/);
    expect(preload).toMatch(/getPathForFile/);
    expect(imp).toMatch(/pathForFile/);
    // 只查代码形态，不查裸的 `f.path` —— 注释里要写清这个坑长什么样
    expect(imp).not.toMatch(/\.filter\(\(f\) => f\.path\)/);
    expect(imp).not.toMatch(/dataTransfer\.files\) as \(File & \{ path/);
    expect(imp).not.toMatch(/\(f\.path \?\? ""\)/);
  });

  it("preload 必须真的把它暴露出去", () => {
    // 只在 preload 里 import 而没挂到 api 上，等于没做
    expect(preload).toMatch(/pathForFile:/);
    expect(types).toMatch(/pathForFile\(file: File\): string/);
  });

  it("拖进来没有视频要给出提示,不能静默", () => {
    // 静默 return 是最难查的一种失败：用户只会觉得"软件坏了"
    expect(imp).toMatch(/没有视频/);
    expect(imp).toMatch(/没读到拖入文件的路径/);
  });

  it("要显式给 dropEffect", () => {
    // 不给的话鼠标显示禁止符号，用户以为这块不能拖
    expect(imp).toMatch(/dropEffect = "copy"/);
  });

  it("可接受扩展名要和主进程一致", () => {
    // 两边不一致会出现"按钮能选、拖进来却说不支持"的自相矛盾
    const main = read("src/main/index.ts");
    const list = /const VIDEO_SRC = \[([^\]]+)\]/.exec(imp)?.[1] ?? "";
    expect(list.length).toBeGreaterThan(0);
    for (const ext of list.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean)) {
      expect(main.toLowerCase(), `主进程缺 .${ext}`).toContain(`.${ext}`);
    }
  });
});

describe("封面图 / 藏带货 / 字幕标题样式", () => {
  const types = read("src/shared/api-types.ts");
  const client = read("src/main/hermes-client.ts");
  const orch = read("../../GLB/Hermes/src/orchestrator/index.js");
  const gen = read("../../GLB/Hermes/src/generator/index.js");

  it("三个新字段必须有完整定义", () => {
    expect(types).toMatch(/coverImage\?: CoverImageStyle/);
    expect(types).toMatch(/tailVideo\?: TailVideoStyle/);
    expect(types).toMatch(/captionFontStyle\?: CaptionStyle/);
    expect(types).toMatch(/titleFontStyle\?: TitleStyle/);
  });

  it("三层都要能收到（客户端→编排→生成器）", () => {
    // 这是最容易漏的一环：任何一层没接，界面勾了就是没反应，且不报错
    for (const f of ["coverImage", "tailVideo", "captionFontStyle", "titleFontStyle"]) {
      expect(client, `hermes-client 没传 ${f}`).toContain(`{ ${f}:`);
      expect(orch, `orchestrator 没传 ${f}`).toContain(`${f}: b.${f}`);
      expect(gen, `generator 没读 ${f}`).toContain(`${f}:`);
    }
  });

  it("wantsWrap 判定要把新选项算进去", () => {
    // 只开"上传封面图"而把字幕/烧标题/生成封面全关掉时，
    // 旧判定会短路直接返回 —— 用户点了出片却什么都没发生
    expect(client).toMatch(/function wantsPackaging/);
    expect(client).toMatch(/opts\.coverImage\?\.usePath/);
    expect(client).toMatch(/opts\.tailVideo\?\.usePath/);
    // 两处调用必须共用同一个函数，不能各写一份（原来两份都漏过东西）
    const uses = client.match(/wantsPackaging\(opts\)/g) ?? [];
    expect(uses.length, "export 与 wrapExistingProject 两处都要用它").toBeGreaterThanOrEqual(2);
    expect(client).not.toMatch(/const wantsWrap = Boolean\(\s*opts && \(opts\??\.subtitles/);
  });

  it("封面和藏带货必须走 filter_complex，不能只用 -vf", () => {
    // concat 必须表达在滤镜图里；只用 -vf 只能处理单个输入
    expect(gen).toMatch(/concat=n=\$\{parts\.length\}:v=1:a=0\[vcat\]/);
    expect(gen).toMatch(/\[vcover\]/);
    expect(gen).toMatch(/\[vtail\]/);
  });

  it("拼接素材存在时不能再叠 -vf", () => {
    // 画面已经在 filter_complex 里拼好，再叠 -vf 等于对成品又处理一次：
    // 字幕/标题会烧两次，zoompan 也会跑两遍
    expect(gen).toMatch(/if \(hasVideoFilter && !videoOut\) encArgs\.push\('-vf', vf\)/);
  });

  it("三路尺寸必须统一，否则 concat 会失败", () => {
    // concat 要求每路宽高/帧率/像素格式完全一致
    expect(gen).toMatch(/function normChain|setsar=1,fps=\$\{FPS\},format=yuv420p/);
  });

  it("输入索引必须动态分配", () => {
    // 写死索引（假定 BGM 一定存在）会在"没 BGM 但有封面"时拿错流，
    // 症状是成片开头插了一段藏带货 —— 极难看出来源
    expect(gen).toMatch(/idxCover = inputCount\+\+/);
    expect(gen).toMatch(/idxTail = inputCount\+\+/);
  });

  it("ASS 颜色是 BGR 不是 RGB", () => {
    // 直接把 #RRGGBB 塞给 PrimaryColour 会红蓝互换。
    // 以前字幕固定白色（两种写法一样）所以没暴露，换颜色才暴露。
    expect(gen).toMatch(/function assColorFromHex/);
    expect(gen).toMatch(/00\$\{b\}\$\{g\}\$\{r\}/);
    expect(gen).toMatch(/assColorFromHex\(String\(cs\.color\)\)/);
  });

  it("字体必须按名字解析成文件，且要有回退", () => {
    // 返回 null 时 drawtext 依赖 fontconfig，而 ffmpeg-static 的 Windows 版
    // 通常没有 fontconfig -> 成片直接失败。必须有回退候选。
    expect(gen).toMatch(/_resolveFontFile\(name = ''\)/);
    expect(gen).toMatch(/'微软雅黑': \['msyhbd\.ttc'/);
    expect(gen).toMatch(/找不到字体.*回退默认字体/s);
  });

  it("字号要按画面高度等比缩放", () => {
    // 固定像素在 720x1280 上会显得巨大，在 4K 上又太小
    expect(gen).toMatch(/h0 \/ 1920/);
  });

  it("文案位置用相对值而不是绝对像素", () => {
    // 封面图尺寸五花八门，绝对像素在不同图上位置完全不同
    expect(gen).toMatch(/textY \?\? 0\.68/);
    expect(gen).toMatch(/y=\(h-text_h\)\*\$\{textY\.toFixed\(3\)\}/);
  });

  it("素材库接口要三处齐全（声明/主进程/preload）", () => {
  const preload = read("src/preload/index.ts");
    for (const m of ["assetList", "assetImport", "assetDelete", "assetRestore", "assetPick"]) {
      expect(types, `StudioApi 缺 ${m}`).toMatch(new RegExp(`${m}\\(`));
      expect(preload, `preload 缺 ${m}`).toMatch(new RegExp(`${m}:`));
    }
    const ipc = read("src/main/asset-ipc.ts");
    for (const ch of ["asset:list", "asset:import", "asset:delete", "asset:restore", "asset:pick"]) {
      expect(ipc, `主进程没注册 ${ch}`).toContain(`"${ch}"`);
    }
  });

  it("删除素材要走回收站，不能直接 rm", () => {
    const store = read("src/main/asset-store.ts");
    expect(store).toMatch(/trashDir/);
    expect(store).toMatch(/await rename\(it\.path/);
  });

  it("素材复制进库而不是记原路径", () => {
    // 用户原图可能在网盘同步目录、名字还可能改，三个月后必须还能出片
    const store = read("src/main/asset-store.ts");
    expect(store).toMatch(/await copyFile\(abs, dest\)/);
  });

  it("选中哪一条必须由主进程决定并回传", () => {
    // 渲染层自己随机会导致"用户看到的"和"实际烧进片子的"不是同一张，
    // 而且完全无感知
    const ipc = read("src/main/asset-ipc.ts");
    expect(ipc).toMatch(/asset:pick/);
    expect(store2()).toMatch(/export async function pickAsset/);
  });

  it("列表要过滤掉磁盘上已消失的条目", () => {
    // 否则界面上出现打不开的缩略图，点了才报错
    const store = read("src/main/asset-store.ts");
    expect(store).toMatch(/const alive = items\.filter\(\(it\) => it\?\.path && existsSync\(it\.path\)\)/);
  });
});

function store2(): string {
  return read("src/main/asset-store.ts");
}

describe("审片必须真的审", () => {
  const client = read("src/main/hermes-client.ts");
  const orch = read("../../GLB/Hermes/src/orchestrator/index.js");
  const panel = read("src/renderer/src/components/ReviewPanel.tsx");
  const dock = read("src/renderer/src/components/ExportDock.tsx");
  const wb = read("src/renderer/src/components/Workbench.tsx");
  const types = read("src/shared/api-types.ts");
  const main = read("src/main/index.ts");
  const preload = read("src/preload/index.ts");
  const clipper = readFileSync("D:/GLB/Hermes/src/clipper/index.js", "utf8");
  const gemini = readFileSync("D:/GLB/Hermes/src/llm/gemini.js", "utf8");
  const app = read("src/renderer/src/App.tsx");

  it("审片意见不能打 404 端点", () => {
    // 真实断链：以前打 POST /projects/review，Hermes 没有这条路由 → 每次 404，
    // 而异常又被界面 .catch(() => undefined) 吞掉。
    // 结果桌面上从来没写进过一条 review_feedback，审片对下一次出片零影响。
    expect(client).not.toMatch(/"\/projects\/review"/);
    expect(client).toMatch(/`\/projects\/\$\{projectId\}\/review`/);
    expect(orch).toMatch(/app\.post\('\/projects\/:id\/review'/);
  });

  it("提交失败必须冒到界面", () => {
    // 审片写了半天没写进去，用户却不知道 —— 比没有审片更糟
    expect(panel).toMatch(/提交失败/);
    expect(wb).not.toMatch(/api\.reviewFeedback[\s\S]{0,120}catch\(\(\) => undefined\)/);
  });

  it("打回必须强制写意见", () => {
    // 空意见的记忆注入没有可执行内容，下次找爆点等于没打回
    expect(panel).toMatch(/打回请写一句意见/);
    expect(orch).toMatch(/打回请写一句意见/);
  });

  it("粗剪要能被看到", () => {
    // 粗剪以前只混在 files 里，包装一开就被 deliver 整个覆盖，
    // 于是界面上永远看不到粗剪，"审片"根本无从下手。
    expect(types).toMatch(/roughcutPath\?: string/);
    expect(types).toMatch(/projectId\?: number/);
    expect(client).toMatch(/roughcutPath: rendered\?\.roughcutPath/);
    expect(client).toMatch(/projectId,/);
    // 不能再塞进 files 里被覆盖
    expect(client).not.toMatch(/files\.push\(rendered\?\.roughcutPath\)/);
  });

  it("段映射由服务端算,不在桌面端复刻", () => {
    // 粗剪时间轴从 0 开始，段落信息来自原素材，换算依赖
    // "按 selected_segments 顺序累加" —— 两处实现早晚会漂移
    expect(orch).toMatch(/review-packet/);
    expect(orch).toMatch(/cursor \+= dur/);
    expect(panel).toMatch(/roughcutStartSec/);
    expect(panel).toMatch(/sourceStartSec/);
  });

  it("审片要同时给粗剪坐标和原素材坐标", () => {
    // 只给一套坐标的话，用户点段落跳画面会跳错地方，
    // 而且完全看不出是坐标系不对
    expect(panel).toMatch(/正在看/);
    expect(panel).toMatch(/粗剪 \{currentSeg\.roughcutStartSec/);
    expect(panel).toMatch(/原素材 \{currentSeg\.sourceStartSec/);
  });

  it("粗剪没渲染出来时要回退并说清楚", () => {
    // 静默播原素材会让用户以为审的是粗剪，实际坐标全对不上
    expect(panel).toMatch(/粗剪还没渲染出来/);
    expect(panel).toMatch(/fallbackPath/);
  });

  it("打回失败时不能把老工程弄丢", () => {
    // 真实 bug：原来是先 updateClipProject(superseded) 再 createProject。
    // 一旦重建失败（点名剔光后没有可用内容），老工程已经是 superseded、
    // 新工程又没建成 —— 这条粗剪就凭空消失了，既没有能看的也没有错误提示。
    const at = orch.indexOf("await this.clipper.createProject(project.live_video_id, {");
    const sup = orch.indexOf("this.store.updateClipProject(id, { status: 'superseded' })");
    expect(at, "找不到 recut 里的 createProject").toBeGreaterThan(-1);
    expect(sup, "找不到归档老工程的调用").toBeGreaterThan(-1);
    expect(sup, "必须先建新工程再归档老的").toBeGreaterThan(at);
  });

  it("相同意见不重复入库", () => {
    // 真实 bug：反复点"确认通过"会一直插同样的意见（实测堆到 6 条）。
    // 记忆注入只取最近 20 条，重复意见会把别的老师的真实反馈挤出窗口。
    expect(orch).toMatch(/已有相同的通过意见，跳过重复入库/);
    expect(orch).toMatch(/comment = \? LIMIT 1/);
  });

  it("段映射要用 segmentId，不是 segmentIndex", () => {
    // selected_segments 里存的是 segmentId（live_segments.id），没有 segment_index。
    // 写 segmentIndex 会全变成 0：界面上每段都显示"第 0 段"，点名打回也指错段。
    expect(orch).toMatch(/selected_segments 里存的是 segmentId/);
    expect(orch).toMatch(/segmentId: s\.segmentId \?\? null/);
  });

  it("getClipProject 已把 JSON 解析成数组，别再 parse 一次", () => {
    // 对数组再 JSON.parse 会抛错、被 catch 吞掉 → 所有工程都返回 0 段，
    // 而且不报错，只表现为"这个工程没有段落"。
    expect(orch).toMatch(/if \(typeof segs === 'string'\)/);
    expect(orch).not.toMatch(/JSON\.parse\(project\.selected_segments \|\| '\[\]'\)/);
  });

  it("segmentId 和 segment_index 都能查到段", () => {
    // 真实 bug：只按 segment_index 建表。审片台发的是 segmentId（全局自增，如 2396），
    // 而 segment_index 是每场从 0 重计（0..248），两者永不相等 ->
    // 所有段静默丢失 -> 报"逐句剔除后没有可用内容"，把排查方向带偏到素材内容上。
    // 实测 174 的 249/249 段全部匹配失败，打回功能等于不可用。
    for (const f of [orch, clipper]) {
      expect(f).toMatch(/const byId = new Map\(\)/);
      expect(f).toMatch(/byId\.get\(key\) \|\| byIndex\.get\(key\)/);
    }
  });

  it("找不到段时要说真话，不要甩锅给逐句剔除", () => {
    expect(clipper).toMatch(/点名的 \$\{missing\.length\} 个分段在这场直播里都找不到/);
    expect(clipper).toMatch(/多半是重分析之后分段被换掉了/);
  });

  it("打回要能按 id 回捞已作废的段", () => {
    // 真实 bug：工程 99/100 引用的是 174 重分析之前的段（id 1065..2395，现已 superseded），
    // 而 getLiveSegmentsByVideo 只返回 draft —— 于是用户在审旧粗剪、说"把开头那句去掉"，
    // 却收到"这段素材没有可用内容"，等于逼他把两小时直播重新分析一遍。
    // 源视频和起止时间都没变，应该按 id 回捞。
    const store = readFileSync("D:/GLB/Hermes/src/memory/store.js", "utf8");
    expect(store).toMatch(/getLiveSegmentsByIds\(ids\)/);
    expect(store).not.toMatch(/getLiveSegmentsByIds[\s\S]{0,400}status = 'draft'/);
    for (const f of [orch, clipper]) {
      expect(f).toMatch(/getLiveSegmentsByIds\?\.\(absent\)/);
      expect(f).toMatch(/只补 draft 里没有的/);
    }
  });

  it("审片包要用真实段序号，不能拿 segmentId 顶替", () => {
    // segmentIndex 原来 fallback 到 segmentId，界面会显示成"第 1115 段"
    expect(orch).toMatch(/indexById\.has\(Number\(s\.segmentId\)\)/);
    expect(orch).not.toMatch(/Number\(s\.segmentIndex \?\? s\.segmentId \?\? 0\)/);
  });

  it("打回要基于原粗剪重建，不能从头自动重选", () => {
    // 真实 bug：打回只传了 feedback/excludeSegmentIds，走 createProject 的自动路径。
    // 后果有两层：① 用户审的是这一版、认可的也是这一版的编排，从头重选等于把他
    // 点过头的段落全换掉，"打回"变成了"重做"；
    // ② 自动路径重跑一遍逐句剔除，而这条粗剪本来就是从自动路径出来的，
    // 对已作废旧段再剔一次会因零长/过短被判死，回一句"逐句剔除后没有可用内容"，
    // 把排查方向指到素材内容上。
    expect(orch).toMatch(/presetSegments: picked,\s*\n\s*feedback: \[comment\]/);
    expect(orch).toMatch(/这条粗剪的段落被你全点名剔掉了/);
    expect(orch).toMatch(/roleById/);
  });

  it("打回重建时要丢掉零长段", () => {
    // 老工程里存着历史零长段（endMs == startMs），presetSegments 这条路不过滤，
    // ffmpeg 切零长出黑帧，审片台点开就是一段黑。实测打回后的新工程带着 8 个。
    expect(clipper).toMatch(/丢弃零长段 #\$\{s\.id \?\? s\.segment_index\}/);
    expect(clipper).toMatch(/打回的段落全是零长段/);
  });

  it.skipIf(!hasE2E)("验证脚本导入素材只能追加，不能覆盖整个索引", () => {
    // 真实 bug，且已让用户丢过两次素材：
    // seedAssets() 用 JSON.stringify([item]) 把 index.json 整个写成"只有这一条"，
    // 用户原有的封面/藏带货在导入这一步就没了。后面 cleanup 再怎么"只删自己那几条"
    // 也救不回来 —— 表现就是素材在界面里凭空消失、文件还躺在磁盘上。
    // 每跑一次 verify:compose-e2e 就抹一次。
    const e2e = readE2E();
    // 只看真正写盘的那行，注释里提到旧写法不算
    const writeCalls = e2e.split("\n").filter((l) => /^\s*fs\.writeFileSync\(.*index\.json/.test(l) || /writeFileSync\(idxFile/.test(l));
    expect(writeCalls.join("\n"), "导入素材时覆盖了整个索引").not.toMatch(/stringify\(\s*\[item\s*\]/);
    expect(e2e).toMatch(/JSON\.stringify\(\[\.\.\.existing, item\]/);
    expect(e2e).toMatch(/追加，绝不覆盖整个索引/);
  });

  it.skipIf(!hasE2E)("e2e 不能写死工程号", () => {
    // 写死 97 的后果不只是 ffprobe 失败：失败发生在 cleanup 之前，
    // 脚本自己造的素材就留在用户库里了。
    const e2e = readE2E();
    expect(e2e).toMatch(/不要写死工程号/);
    expect(e2e).toMatch(/api\/projects/);
    expect(e2e, "还在用写死的工程号").not.toMatch(/projectId:\s*97\b/);
    expect(e2e).not.toMatch(/project_97/);
  });

  it("点段落必须真的跳播放头", () => {
    // 界面上写着"点行跳到该段"，实际 onClick 只 setActiveSeg，
    // 而 activeSeg 只用于高亮 —— 按钮在骗人。而且行数常有上百条，
    // 不能靠手动滚列表去对着画面。
    expect(panel).toMatch(/const jumpTo = \(idx: number\)/);
    expect(panel).toMatch(/seekTo\(s\.roughcutStartSec\)/);
    expect(panel).toMatch(/onClick=\{\(\) => jumpTo\(idx\)\}/);
    expect(panel).not.toMatch(/onClick=\{\(\) => setActiveSeg\(idx\)\}/);
  });

  it("跳转要能重复触发，不能靠 seekTo 的值变化", () => {
    // seekTo 是 useEffect([seekTo])，值不变就不触发 —— 连点同一段时
    // 第二次点击毫无反应，而"回听同一句话"恰恰是审片最高频的动作。
    expect(panel).toMatch(/registerApi/);
    expect(panel).toMatch(/pendingSeek/);
    expect(panel).toMatch(/api\.seek\(pendingSeek\.current\)/);
  });

  it("高亮只能有一个来源：播放头位置", () => {
    // 原来有 activeSeg(点击)和 currentSeg(播放头) 两套高亮，会互相打架：
    // 点了 A 段高亮 A，播到 B 段"正在看"是 B，同屏两个都亮。
    expect(panel).toMatch(/const currentIdx = useMemo/);
    expect(panel).not.toMatch(/const \[activeSeg, setActiveSeg\]/);
  });

  it("播放头走到哪，当前行滚到哪", () => {
    expect(panel).toMatch(/rowRefs/);
    expect(panel).toMatch(/box\.scrollTo/);
  });

  it("审片台自己接管键盘，全局快捷键要让位", () => {
    // 真实 bug：空格是全局的，审片台弹在工作台上面，
    // 按空格暂停的是背后那个播放器，画面纹丝不动，像坏了。
    // 而 A/D 会误触全选/反选改掉选片结果。
    const sc = read("src/renderer/src/hooks/useShortcuts.ts");
    expect(sc).toMatch(/enabled\?: boolean/);
    expect(sc).toMatch(/if \(get\(\)\.enabled === false\) return;/);
    expect(sc, "enabled 不能只在挂载时读一次").toMatch(/get\(\)\.enabled/);
    expect(wb).toMatch(/enabled: !showReview/);
    expect(panel).toMatch(/case " ":[\s\S]{0,120}playback\.current\?\.toggle\(\)/);
    expect(panel).toMatch(/case "\[":[\s\S]{0,120}stepSeg\(-1\)/);
  });

  it("打回后要换成新工程的粗剪，不能还播旧文件", () => {
    // 审片台以 packet.roughcutPath 为准（它跟着工程走），
    // prop 只作兜底；并且打回后要把新路径交回工作台，
    // 否则下次开审片还是上一版的文件。
    expect(panel).toMatch(/packet\?\.roughcutPath \|\| roughcutPath/);
    expect(panel).toMatch(/onRecutDone\?\.\(r\.newProjectId, packetRef\.current\?\.roughcutPath\)/);
    expect(wb).toMatch(/setRoughcutPath\(newRoughcutPath \?\? null\)/);
  });

  it("云端请求必须能走代理,否则在这台机器上永远连不上", () => {
    // 这台机器开着 Clash(Windows 系统代理 127.0.0.1:4780)，而 Electron/Node 的
    // fetch 只认环境变量里的代理、不读系统代理设置 —— 于是所有云端请求都在直连，
    // 表现是"API 用不了"，实际是连都没连上（连服务端的 401 都拿不到）。
    // 排查时最容易误判成 key 失效，白白反复换 key。
    const proxy = readFileSync("D:/GLB/Hermes/src/llm/proxy.js", "utf8");
    const hermesMain = readFileSync("D:/GLB/Hermes/src/hermes.js", "utf8");
    const guard = readFileSync("D:/GLB/hermes-guard.js", "utf8");

    // 优先级：手填 > 环境变量 > Windows 系统代理
    expect(proxy).toMatch(/cfg\?\.llm\?\.proxy \?\? cfg\?\.gemini\?\.proxy/);
    expect(proxy).toMatch(/process\.env\.HTTPS_PROXY/);
    expect(proxy).toMatch(/readWindowsProxy\(\)/);
    expect(proxy).toMatch(/ProxyEnable\\s\+REG_DWORD/);
    // 分协议的代理串也要认：Clash 有时写成 http=...;https=...
    expect(proxy).toMatch(/\^https=/i);

    // 必须在第一次 fetch 之前灌好
    expect(hermesMain).toMatch(/applyProxyEnv\(config\)/);
    expect(hermesMain).toMatch(/Outbound proxy:/);

    // NODE_USE_ENV_PROXY 只在进程启动时解析一次，运行期再设无效 —— 必须由启动器带上
    expect(guard).toMatch(/NODE_USE_ENV_PROXY: '1'/);
    expect(guard).toMatch(/env: \{ \.\.\.process\.env, NODE_USE_ENV_PROXY/);

    // 三处 fetch 都要走诊断版，别留一处裸 fetch
    expect(gemini).not.toMatch(/(?<![\w.])fetch\(/);
    expect(gemini).toMatch(/fetchWithDiagnostics/);
  });

  it("代理探测优先级要和 Hermes 一致,否则界面说连上了实际连不上", () => {
    expect(main).toMatch(/function detectProxy/);
    expect(main).toMatch(/if \(m\) return \{ url: \/\^https\?:\\\/\\\//);
    expect(main).toMatch(/process\.env\.HTTPS_PROXY \|\| process\.env\.HTTP_PROXY/);
    expect(main).toMatch(/Windows 系统代理/);
    expect(main).toMatch(/^\/\/ .*，readWindowsProxy|优先.*环境变量/s);
  });

  it("代理地址要能存进 Hermes 配置,否则只改了桌面端", () => {
    expect(main).toMatch(/cfg\.llm = \{ \.\.\.\(cfg\.llm \?\? \{\}\)/);
    expect(main).toMatch(/proxy: s\.proxy\.trim\(\)/);
    expect(types).toMatch(/proxy: string;/);
    expect(app).toMatch(/draft\.proxy/);
    expect(app).toMatch(/已自动识别到系统代理/);
  });

  it("探活要分级报错,并能发现模型名填错", () => {
    // 四种失败的处理办法完全不同：key 无效 / 地址协议错 / 没连上网 / 模型名不存在。
    // 以前一律报 HTTP 401 或"连接失败"，用户只能反复换 key，而问题根本不在 key。
    expect(main).toMatch(/function describeHttpFailure/);
    expect(main).toMatch(/这是 key 的问题，不是网络问题/);
    expect(main).toMatch(/多半是地址少写了 \/v1，或协议选错了/);
    // 模型名错通常不报错，只是列表里没有 —— 主动指出来
    expect(main).toMatch(/modelHint/);
    expect(main).toMatch(/models\.includes\(s\.cloud\.model\)/);
    expect(main).toMatch(/把 HTTP 失败翻译成/);
  });

  it("按记忆里找爆点:毫秒不能被当成秒", () => {
    // 真实 bug：3 小时的视频产出 2330000 秒的候选，界面显示 "2330000.0s"。
    // 根因是 ASR 缓存存的是 start_ms/end_ms（毫秒），而兜底路径只读
    // startSec/endSec 和 start/end，全都匹配不上 → 单位无人确认，一路错到最底下。
    // 现在读四种字段名 + 入口处做量级护栏。
    expect(orch).toMatch(/Number\.isFinite\(s\.start_ms\)\) startMs = Number\(s\.start_ms\)/);
    expect(orch).toMatch(/Number\.isFinite\(s\.end_ms\)\) endMs = Number\(s\.end_ms\)/);
    expect(orch).toMatch(/normalizeToMs/);
    expect(orch).toMatch(/SECONDS_UPPER_BOUND = 100_000/);
    expect(orch).toMatch(/逐句稿的时间戳单位不对/);
  });

  it("按记忆里找爆点:超长块硬切后每片要有自己的原文", () => {
    // 真实 bug：直播"每几秒一句"把整场连成一个巨块，超长块按 maxPer 硬切，
    // 但每片都塞整块的第一句 → 8 条候选标题一模一样。
    // 用户看到的是"筛出来全是同一条"，而真相是同一段被复制了 8 次。
    expect(orch).toMatch(/const srcSorted = x\.pieces/);
    expect(orch).toMatch(/textExact: Boolean\(exact \|\| pieceText\)/);
    // 不能无条件用 p.text
    expect(orch).not.toMatch(/text: p\.text\.slice\(0, 120\),\s*\n\s*\}/);
  });

  it("按记忆里找爆点:标题重复要标出来", () => {
    // 标题相同就说明这些条来自同一段连续内容。
    // 直接标出来，好过让用户面对一屏一模一样的卡片自己猜。
    expect(orch).toMatch(/textApproximate/);
    expect(orch).toMatch(/m\.titleDup = byTitle\.get\(key\)/);
    expect(orch).toMatch(/多半来自同一段连续内容/);
  });

  it("有可用分段时不能谎称没有结果", () => {
    // 真实问题：live-result 原来是 `status === 'completed' ? segments : []`。
    // 而分析被取消、或进程上次异常退出被启动自愈归位成 pending 之后，
    // 库里的分段其实完好（实测 207 段），这里却返回空数组 →
    // 界面显示"0 段"，用户以为整场分析白跑了。
    // 状态只说明"这轮跑到哪了"，不代表已有数据不能用。
    expect(orch).toMatch(/const hasResult = segments\.length > 0;/);
    expect(orch).not.toMatch(/status === 'completed'\s*\n?\s*\?\s*\(this\.store\.getLiveSegmentsByVideo/);
    // 有货就别再说 running:true，否则界面一直转圈
    expect(orch).toMatch(/running: \(status === 'analyzing' \|\| status === 'pending'\) && !hasResult/);
  });

  it("启动时要归位上次遗留的 analyzing", () => {
    // 进程被 kill/崩溃/关窗时，分析停在 analyzing。
    // live-result 看到 analyzing 就回 running:true → 界面永远转圈，
    // 而且这个状态会一直挂着，调度器还可能反复重排它。
    expect(orch).toMatch(/\[Recovery\]/);
    expect(orch).toMatch(/WHERE analysis_status = 'analyzing'/);
    expect(orch).toMatch(/finishedAt/);
  });

  it("取消要能打断整条链路,不只是让 JS 抛错", () => {
    // 真实 bug（实测取消后 281 秒才归位）：abort 只让 JS 抛错，
    // 而几个真正耗时的环节都不理它：
    //   ① ASR 跑在 Worker 线程里 —— AbortSignal 打不进 Worker
    //   ② ffmpeg/sherpa/whisper 是 spawn 的子进程 —— 没有中断通道
    //   ③ 本机 8B 跑一个 chunk 要几十秒到几分钟 —— LLM 客户端用自己的
    //      AbortController，和用户的取消完全无关
    // 结果：用户点了取消，CPU 还在满载、分析状态一直停在 analyzing。
    const sh = readFileSync("D:/GLB/Hermes/src/analyzer/sherpa-asr.js", "utf8");
    expect(sh).toMatch(/signal\.addEventListener\('abort', onAbort/);
    expect(sh, "取消时不 terminate，Worker 里的 native 解码会继续跑").toMatch(/worker\.terminate\(\)/);
    expect(sh).toMatch(/checkAbort\(\)/);

    const ah = readFileSync("D:/GLB/Hermes/src/analyzer/asr-helper.js", "utf8");
    expect(ah).toMatch(/sherpa\.transcribe\(videoPath, null, opts\.signal \?\? null\)/);
    expect(ah).toMatch(/static killAll\(\)/);
    expect(ah).toMatch(/taskkill/);

    const ol = readFileSync("D:/GLB/Hermes/src/llm/ollama.js", "utf8");
    expect(ol, "LLM 调用没接 signal，取消后整场分析还在跑").toMatch(/options\.signal\.addEventListener\('abort', onExternalAbort/);
    // OOM 重试也要能被取消打断，不能单独建 AbortSignal.timeout
    expect(ol).not.toMatch(/signal: AbortSignal\.timeout\(Math\.max\(60_000, options\.timeout/);

    // 取消不能被"这一块没结果"的 catch 吞掉
    const an = readFileSync("D:/GLB/Hermes/src/analyzer/live-analyzer.js", "utf8");
    expect(an).toMatch(/_isAbort\(err\)/);
    expect(an).toMatch(/if \(this\._isAbort\(err\)\) throw err;/);
  });

  it("取消端点要能归位悬空的 analyzing", () => {
    // 上一次 analyze-live 因进程被杀/崩溃停在 analyzing，finally 根本没机会跑，
    // 状态就永久悬着。这时用户点取消，服务端找不到进行中的请求（aborted=false），
    // 于是什么都不做 —— analyzing 永远留着，界面一直转圈。
    // 实测：取消 27ms 返回，6 秒后 analyzing 还挂着。
    expect(orch).toMatch(/无进行中的请求，把悬空的 analyzing 归位/);
    expect(orch).toMatch(/WHERE id = \? AND analysis_status = 'analyzing'/);
  });

  it("UI 性能报告不能靠字面 grep,否则会退化成假阳性", () => {
    // 真实教训：报告脚本原来直接 grep "setTick"。修复之后那个词只存在于
    // 解释"以前怎么做的"注释里，脚本于是仍然报"每秒重渲染整个工作区" ——
    // 假阳性比漏报更糟：会让人以为修复没生效而反复排查。
    const probe = readScriptIfPresent("probe-ui-perf.cjs");
    // 先剥注释再判断
    expect(probe, "没有剥注释，注释里的词会被当成代码").toMatch(/function stripComments/);
    expect(probe).toMatch(/stripComments\(fs\.readFileSync/);
    // 按组件定位，不能按文件：ElapsedBadge 和 Workbench 在同一个文件里，
    // 但前者 29 行、后者 1465 行，代价天差地别
    expect(probe).toMatch(/function ownerComponent/);
    expect(probe).toMatch(/function componentSpan/);
    expect(probe).toMatch(/ElapsedBadge/);
    // 阈值要有依据，不能看到 .map 就报警
    expect(probe).toMatch(/LARGE_THRESHOLD = 150/);
    expect(probe, "只看有没有虚拟化，没量真实条数").toMatch(/assets > LARGE_THRESHOLD/);
    expect(probe).toMatch(/maxSentences > 100/);
    // 我们自己的实现也要算虚拟化
    expect(probe).toMatch(/<WindowedList/);
  });

it("审片包必须带上可编辑原文,否则框选删除无从下手", () => {
    // 审片台要"像编辑文本框一样框选几个字删掉"，
    // 而 selected_segments 里只有主题名和时间轴 —— 没有文本就没有东西可选。
    expect(orch).toMatch(/buildEditableText\(transcript, start, end\)/);
    expect(orch).toMatch(/text: editable\.text/);
    expect(orch).toMatch(/sentences: editable\.sentences/);
    // 实操教学段（几乎没文字）要单独标记，界面才显示成时间区间块
    expect(orch).toMatch(/textless: tl\.textless/);
    // 已有剪辑区间要回传，界面才能显示删除线
    expect(orch).toMatch(/cuts: Array\.isArray\(s\.cuts\)/);
    // 但 live-result 绝对不能带原文：那是一次几百段的响应，会膨胀到几 MB
    expect(orch).not.toMatch(/live-result[\s\S]{0,400}buildEditableText/);
  });

  it("秒/毫秒换算的括号不能错", () => {
    // 隐蔽到只能靠真数据发现的 bug：
    // 写成 Math.max(a, toSec || 0) * 1000，会把已经换算成毫秒的 a 又乘一次 1000，
    // 于是 60 秒的范围变成 1750 秒 —— 命中 910 句（整场三分之一）、每段文本 6 万字。
    // 数学上"看起来"没问题，单元测试用小数据也发现不了。
    const et = readFileSync("D:/GLB/Hermes/src/analyzer/editable-text.js", "utf8");
    expect(et).not.toMatch(/Math\.max\(a, Number\(toSec\) \|\| 0\) \* 1000/);
    expect(et).toMatch(/Math\.max\(a, \(Number\(toSec\) \|\| 0\) \* 1000\)/);
    // 再加一道防线：范围离谱就直接拒绝，宁可不给也不要整场文本
    expect(et).toMatch(/if \(b - a > 86_400_000\)/);
    expect(et).toMatch(/入参单位可能不是秒/);
  });

  it("无/少文本的实操教学段要能识别出来", () => {
    // 教学直播里大量片段是现场演示、弹琴、唱歌，ASR 只能识别零星几个字。
    // 这种段恰恰通常是要保留的爆点核心，给它一个空文本框用户只会以为功能坏了。
    const et = readFileSync("D:/GLB/Hermes/src/analyzer/editable-text.js", "utf8");
    expect(et).toMatch(/export function describeTextless/);
    expect(et).toMatch(/多半是现场演示/);
    expect(et).toMatch(/density < 4/);
  });

  it("analysis_health 传对象也要能正确落库", () => {
    // 真实 bug：upsertLiveVideo 用 String(data.analysisHealth) 规范化，
    // 而"取消分析"那处传的是 health 对象 —— String({}) 得到 "[object Object]"，
    // 这一轮的体检记录整个报废（grade/error/降级原因全丢）。
    // 而调度器判断该不该重跑、"重新分析"提示、以及排查"结果可不可信"，
    // 全都读这个字段。记录没了就只能瞎猜。
    const st = readFileSync("D:/GLB/Hermes/src/memory/store.js", "utf8");
    expect(st).toMatch(/typeof data\.analysisHealth === 'string' \? data\.analysisHealth : JSON\.stringify\(data\.analysisHealth\)/);
    expect(st).not.toMatch(/\? String\(data\.analysisHealth\)/);
    const an = readFileSync("D:/GLB/Hermes/src/analyzer/live-analyzer.js", "utf8");
    expect(an).toMatch(/health\.grade = 'cancelled'/);
  });

  it("API 三处必须齐全", () => {
    // 少改一处就静默失效 —— 这是本项目反复踩的坑
    for (const m of ["reviewPacket", "submitReview"]) {
      expect(types, `StudioApi 缺 ${m}`).toMatch(new RegExp(`${m}\\(`));
      expect(preload, `preload 缺 ${m}`).toMatch(new RegExp(`${m}:`));
      expect(client, `hermes-client 缺 ${m}`).toMatch(new RegExp(`async ${m}\\(`));
    }
    expect(main).toMatch(/"algo:reviewPacket"/);
    expect(main).toMatch(/"algo:submitReview"/);
  });

  it("点名打回要和『看』分开", () => {
    // 勾选框的语义必须写清楚：勾了不代表在看，代表要拉黑
    expect(panel).toMatch(/点名打回/);
    expect(panel).toMatch(/已点名 \$\{rejectIds\.size\} 段/);
  });

  it("审片入口要给出片台常驻", () => {
    // 以前只能去输出目录手动找粗剪文件
    expect(dock).toMatch(/onOpenReview/);
    expect(dock).toMatch(/审片/);
    expect(wb).toMatch(/onOpenReview=\{\(\) => setShowReview\(true\)\}/);
  });

  it("审片历史要能看到", () => {
    expect(types).toMatch(/export interface ReviewRecord/);
    expect(types).toMatch(/export interface ReviewPacket/);
    expect(panel).toMatch(/审片历史/);
  });

  it("批注不能在 onChange 里就提交", () => {
    // 真实 bug：textarea onChange 调 onSave，而 onSave 里 setReviewId(null)
    // → 打第一个字弹窗就消失，批注写不完
    expect(wb).not.toMatch(/onChange=\{\(e\) => onSave\(\{ reviewNote/);
    expect(wb).toMatch(/const \[note, setNote\] = useState/);
    expect(wb).toMatch(/reviewNote: note/);
  });
});

describe("素材不能丢", () => {
  const store = read("src/main/asset-store.ts");
  // 惰性读：describe 体在收集阶段就执行，这里直接 readE2E() 会让
  // 整个文件因 ENOENT 崩掉，连不依赖该脚本的用例一起陪葬。
  const e2e = hasE2E ? readE2E() : "";

  it("孤儿文件要自动补回索引（只清理一个方向会永久丢素材）", () => {
    // 真实发生过：索引被整体覆盖成 []，用户 4 张封面 + 4 段视频失联。
    // 文件还在磁盘上，界面却空空如也，唯一出路是重新上传。
    // listAssets 只处理"索引有、磁盘没了"就永远发现不了这些孤儿。
    expect(store).toMatch(/磁盘有但索引没有/);
    expect(store).toMatch(/const recovered: AssetItem\[\] = \[\]/);
    expect(store).toMatch(/const merged = \[\.\.\.alive, \.\.\.recovered\]/);
    // 回写条件要包含"补回了东西"，否则补回后不落盘，下次又丢
    expect(store).toMatch(/recovered\.length > 0/);
  });

  it("恢复出来的素材要还原原始文件名", () => {
    // 文件名被改成了 "<时间戳>-<随机>.<ext>"，
    // 不还原的话界面上全是 "w7bwub.jpg" 这种用户看不懂的名字
    expect(store).toContain("/^(\\d+)-([a-z0-9]+)$/");
    expect(store).toMatch(/name: m \? stem\.slice/);
  });

  it("导入必须复制进库，不能只记原路径", () => {
    // 用户原图可能在网盘同步目录、移动硬盘，名字还可能改。
    // 三个月后还能出片，是素材库存在的全部意义。
    expect(store).toMatch(/await copyFile\(abs, dest\)/);
  });

  it("验证脚本不能整个覆盖索引", () => {
    // 踩过的坑：e2e 脚本清理时写 index.json = []，
    // 把用户自己上传的素材索引一起抹掉了
    expect(e2e).not.toMatch(/writeFileSync\(path\.join\(ASSET_ROOT, a\.kind, "index\.json"\), "\[\]"/);
    // 必须是"读出来、只删自己那几条、其余原样写回"
    expect(e2e).toMatch(/const list = JSON\.parse\(fs\.readFileSync\(idxFile/);
    expect(e2e).toMatch(/const kept = list\.filter\(\(x\) => !mine\.has\(x\.id\)\)/);
  });

  it("删除素材要走回收站", () => {
    expect(store).toMatch(/trashDir/);
    expect(store).toMatch(/await rename\(it\.path/);
    expect(store).toMatch(/export async function restoreAssets/);
  });
});

describe("云端协议适配", () => {
  const gemini = read("../../GLB/Hermes/src/llm/gemini.js");
  const main = read("src/main/index.ts");
  const types = read("src/shared/api-types.ts");
  const app = read("src/renderer/src/App.tsx");

  it("两种协议都要支持,不能只改地址", () => {
    // 官方是 ?key= + :generateContent,中转是 Bearer + /chat/completions。
    // 只改 baseUrl 去接中转必然 401/404,而报错看不出是协议不对。
    expect(gemini).toMatch(/openai-compatible/);
    expect(gemini).toMatch(/generativelanguage\.googleapis\.com/);
    expect(gemini).toMatch(/api\.openai\.com\/v1/);
  });

  it("key 的位置必须跟着协议变", () => {
    expect(gemini).toMatch(/Authorization: `Bearer \$\{this\.apiKey\}`/);
    expect(gemini).toMatch(/\?key=\$\{encodeURIComponent\(this\.apiKey\)\}/);
  });

  it("请求体和响应结构都要按协议切换", () => {
    expect(gemini).toMatch(/chat\/completions/);
    expect(gemini).toMatch(/max_tokens: maxTokens/);
    expect(gemini).toMatch(/choices\?\.\[0\]\?\.message\?\.content/);
    expect(gemini).toMatch(/candidates\?\.\[0\]\?\.content\?\.parts/);
  });

  it("看图也要按协议切换,失败要回落而不是抛", () => {
    expect(gemini).toMatch(/image_url/);
    expect(gemini).toMatch(/inlineData/);
    expect(gemini).toMatch(/async describe[\s\S]{0,3000}catch \{[\s\S]{0,40}return null/);
  });

  it("模型列表的字段名两种协议不同", () => {
    /*
     * 原来这里断言的是 `payload?.data || []` / `payload?.models || []` 直接写在 health() 里。
     * 2026-10-06 加了 {code,data} 信封自动剥离后，取模型列表前会先走
     * _unwrapEnvelope()，于是变量名从 payload 变成了 data，正则再也匹配不上 ——
     * 这条断言其实是在拦一次重构，但它拦的方式是"写死变量名"，所以自己先失效了。
     *
     * 现在钉的是**结构**而不是变量名：两种协议各自的字段名还在，
     * 并且剥信封那一步在取列表之前发生。
     */
    expect(gemini).toMatch(/_unwrapEnvelope/);
    expect(gemini).toMatch(/\?\.\s*data\s*\|\|\s*\[\]/);   // OpenAI 兼容：data[].id
    expect(gemini).toMatch(/\?\.\s*models\s*\|\|\s*\[\]/); // Google 原生：models[].name
    // 剥信封必须发生在取模型列表之前（顺序错了会把信封当成 models 列表）
    const unwrap = gemini.indexOf('const payload = this._unwrapEnvelope(data)');
    const list = gemini.search(/\?\.\s*data\s*\|\|\s*\[\]/);
    expect(unwrap, "取模型列表前必须先剥 {code,data} 信封").toBeGreaterThan(-1);
    expect(unwrap).toBeLessThan(list);
  });

  it("报错要带协议名,否则分不清是协议错还是 key 错", () => {
    expect(gemini).toMatch(/Gemini 未返回内容（\$\{this\.protocol\}）/);
    // HTTP 失败改成走分级报错 describeHttpFailure（见「分级报错」那组测试）。
    // 但协议名仍然要出现在报错里 —— 不然 401 到底是协议不匹配还是 key 失效依旧分不清。
    expect(gemini).toMatch(/describeHttpFailure[\s\S]{0,200}protocol/);
    expect(gemini).toMatch(/describeHttpFailure\(res\.status, res\.statusText, errText\)/);
    expect(gemini).toMatch(/describeHttpFailure\(res\.status, res\.statusText, body\)/);
  });

  it("协议必须同步到 Hermes 配置,否则存了不生效", () => {
    expect(main).toMatch(/protocol: s\.cloudProtocol/);
    expect(main).toMatch(/baseUrl: s\.cloudBaseUrl\.trim\(\)/);
  });

  it("地址留空时不能写成空字符串", () => {
    // 写成 '' 会让 baseUrl 变成空,请求路径变成 /models/...,全部 404
    expect(main).toMatch(/s\.cloudBaseUrl && s\.cloudBaseUrl\.trim\(\) \? \{ baseUrl/);
  });

  it("探活也要按协议走,否则中转永远显示不可用", () => {
    expect(main).toMatch(/const oai = s\.cloudProtocol === "openai-compatible"/);
    expect(main).toMatch(/Authorization: `Bearer \$\{s\.cloud\.apiKey\}`/);
    // 网络不通要和 key 错能分辨，而且要指出"要不要配代理"——
    // 这台机器默认直连出不去，不说清的话用户只会反复换 key。
    expect(main).toMatch(/当前是直连。若这台机器开了 Clash\/v2ray，请在上方「代理」里填地址。/);
    expect(main).toMatch(/已走代理 \$\{out\.proxy\}，检查代理软件是否在运行。/);
  });

  it("设置面板要给用户选协议的入口", () => {
    expect(app).toMatch(/openai-compatible/);
    expect(app).toMatch(/gemini-native/);
    expect(app).toMatch(/接口协议/);
    expect(app).toMatch(/接口地址/);
  });

  it("契约要有这两个字段", () => {
    expect(types).toMatch(/cloudProtocol\?: CloudProtocol/);
    expect(types).toMatch(/cloudBaseUrl\?: string/);
    expect(types).toMatch(/export type CloudProtocol = "gemini-native" \| "openai-compatible"/);
  });

  it("拼错的协议要退回原生,不能变成未定义行为", () => {
    expect(gemini).toMatch(/g\.protocol === 'openai-compatible' \? 'openai-compatible' : 'gemini-native'/);
  });
});

describe("工作台布局不能重叠", () => {
  const wb = read("src/renderer/src/components/Workbench.tsx");
  const cl = read("src/renderer/src/components/CandidateList.tsx");
  const tp = read("src/renderer/src/components/TranscriptPanel.tsx");

  it("用了 flex-1 的组件,它的父容器必须是 flex 容器", () => {
    // 这个坑非常隐蔽：CandidateList 根元素写着 flex-1，看起来"约束住了"，
    // 但 flex-1 只在 flex 容器里生效。父层少一个 flex 类，它就退化成普通 block，
    // 高度按内容算 —— 实测 258 张卡片把盒子撑到 18104px，往下溢出盖住逐句稿，
    // 两层半透明内容叠在一起。从 DOM 结构上完全看不出问题。
    expect(cl).toMatch(/className="flex min-h-0 flex-1 flex-col/);
    expect(wb).toMatch(/className="flex min-h-0 flex-1 overflow-hidden"\s*>\s*\{candidates/);
  });

  it("逐句稿的包装层也要是 flex 容器", () => {
    // TranscriptPanel 根元素是 h-full，父层不是 flex 时 h-full 同样会跑偏
    expect(wb).toMatch(/className="flex min-h-\[120px\] shrink overflow-hidden"/);
    expect(tp).toMatch(/className="flex h-full min-h-0 flex-col overflow-hidden/);
  });

  it("逐句稿不能用 height 百分比 + shrink-0", () => {
    // height 百分比在 flex item 里只是"期望高度"，shrink-0 又禁止收缩：
    // 比例是 localStorage 里的脏值时，它会撑到远超容器并压住候选列表
    expect(wb).not.toMatch(/shrink-0"\s+style=\{\{ height: `\$\{trRatio/);
    expect(wb).toMatch(/flexBasis: `\$\{clampRatio\(trRatio\)/);
  });

  it("分隔比例必须夹紧,脏值不能直接用", () => {
    // 实测脏值 5 时旧写法让候选列表高度变成 0（列表整个消失）
    expect(wb).toMatch(/function clampRatio/);
    expect(wb).toMatch(/Number\.isFinite\(r\)/);
  });

  it("播放器和时间轴那两栏不能被内容撑开", () => {
    // 左栏是 shrink-0 + 百分比宽度，父层必须 min-h-0，否则播放器会撑破布局
    expect(wb).toMatch(/flex min-h-0 shrink-0 flex-col gap-2\.5/);
  });
});

describe("长直播超时与零长段", () => {
  const client = read("src/main/hermes-client.ts");
  const orch = read("../../GLB/Hermes/src/orchestrator/index.js");
  const analyzer = read("../../GLB/Hermes/src/analyzer/live-analyzer.js");
  const types = read("src/shared/api-types.ts");
  const wb = read("src/renderer/src/components/Workbench.tsx");

  it("超时要按素材时长给,不能一律 15 分钟", () => {
    // 两三小时直播的完整分析实测 30~60 分钟。一律 15 分钟的话,
    // 每个长直播都会在快跑完时超时(我们踩过:跑 14 分钟后报"调用超时")。
    expect(client).toMatch(/Math\.min\(3 \* 60 \* 60_000, Math\.max\(20 \* 60_000/);
    expect(types).toMatch(/durationSec\?: number/);
    expect(wb).toMatch(/durationSec: file\.durationSec/);
  });

  it("必须有回读端点,否则超时就只能报错", () => {
    // 服务端会继续跑完并写库,客户端超时不代表分析失败。
    // 没有回读就只能让用户白等一场。
    expect(orch).toMatch(/\/pipeline\/live-result/);
    expect(client).toMatch(/fetchLiveResult/);
  });

  it("超时要先回读再报错", () => {
    const at = client.indexOf("fetchLiveResult(request_.filePath)");
    expect(at, "detect 的 catch 里应先尝试回读").toBeGreaterThan(-1);
    // 回读到就当成功，回读不到才抛原错
    expect(client).toMatch(/if \(!recovered\) throw err/);
  });

  it("回读不能返回半成品", () => {
    // 真的没跑出东西时不能谎报成功。
    // 但反过来：已经有可用分段时必须给（见「有可用分段时不能谎称没有结果」）——
    // 取消/异常退出后库里往往还留着完好分段，返回空数组会让用户以为白分析了。
    expect(orch).toMatch(/const hasResult = segments\.length > 0;/);
    expect(orch).toMatch(/running: \(status === 'analyzing' \|\| status === 'pending'\) && !hasResult/);
    expect(client).toMatch(/if \(r\.running === true \|\| !r\.segments \|\| r\.segments\.length === 0\) return null/);
  });

  it("回读只取活跃批次", () => {
    // 混进 superseded 的上一轮分段,segment_index 就重复了,
    // 而时间轴偏移是按序号累加的,重复的 index 会让 clipper 算错
    expect(orch).toMatch(/getLiveSegmentsByVideo\?\.\(vid\)/);
  });

  it("结果取自缓存要如实告知用户", () => {
    // 悄悄显示"分析完成"会让人以为这次是正常跑完的,
    // 下次超时又会觉得莫名其妙
    expect(client).toMatch(/结果取自分析缓存/);
  });

  it("零长段要在写库前剔除,不能只过滤返回值", () => {
    // 这是个真漏过的坑：过滤加在了返回值上，但写库循环用的是 allSegments ——
    // 零长段照样进库，下次重分析又被污染，而且界面照旧显示一排"0 秒"候选。
    // 过滤必须在 addLiveSegment 那个循环之前。
    const ana = read("../../GLB/Hermes/src/analyzer/live-analyzer.js");
    const filterAt = ana.indexOf("allSegments = allSegments.filter(");
    // 用 lastIndexOf：addLiveSegment 在文件里有定义也有调用点，
    // 取第一次会命中别处，比较出来的顺序就没意义了
    const writeAt = ana.lastIndexOf("this.store.addLiveSegment({");
    expect(filterAt, "找不到零长段过滤").toBeGreaterThan(-1);
    expect(writeAt, "找不到写库循环").toBeGreaterThan(-1);
    expect(filterAt, "过滤必须在写库之前").toBeLessThan(writeAt);
    // 循环体遍历的必须是已过滤的 allSegments
    expect(ana.slice(writeAt - 80, writeAt)).toMatch(/for \(const seg of allSegments\)/);
  });

  it("剔除数量要记进体检报告,便于事后追查", () => {
    const ana = read("../../GLB/Hermes/src/analyzer/live-analyzer.js");
    expect(ana).toMatch(/health\.zeroLengthDropped = droppedZero/);
  });

  it("跳过的零长段要告知,不能静默", () => {
    // 用户会发现"候选比预期少几条"却不知道原因
    expect(client).toMatch(/已跳过 \$\{droppedZeroLength\} 个零长片段/);
  });
});

describe("白名单漏字段(第三次踩的坑)", () => {
  const gen = read("../../GLB/Hermes/src/generator/index.js");

  /**
   * 这个坑已经踩了三次：
   *   1. hermes-client 的 runGenerate 请求体漏字段
   *   2. orchestrator 的 /pipeline/generate 解构漏字段
   *   3. generator 内部 _composeFinalVideo 的 opts 又漏一次
   * 症状全都是同一个：界面勾了、设置存了、出片文件也生成了，
   * 但效果完全没变化 —— 不报错，所以从代码上看不出来。
   *
   * 下面这个测试从 generateAll 的归一化列表出发，
   * 逐个检查每一层有没有继续往下传。新加选项忘了加哪一层就会红。
   */
  const options = [
    "coverImage",
    "tailVideo",
    "captionFontStyle",
    "titleFontStyle",
    "titleCardSeconds",
    "coldOpenSeconds",
    "vertical",
    "captionStyle",
    "coldOpen",
    "titleCard",
    "autoZoom",
    "watermark",
    "bgmPath",
    "bgmVolume",
    "duckBgm",
    "sfx"
  ];

  it("generateAll 的归一化必须覆盖每一个出片选项", () => {
    const start = gen.indexOf("async generateAll(");
    // 必须用**定义处**做切片终点。用 "_generateAllInner(" 会匹配到 generateAll
    // 内部的调用处，slice 出来只有几行，测试等于什么都没验。
    const end = gen.indexOf("async _generateAllInner(", start);
    expect(start, "找不到 generateAll").toBeGreaterThan(-1);
    expect(end, "找不到 _generateAllInner 定义").toBeGreaterThan(start);
    const block = gen.slice(start, end);
    for (const o of options) {
      expect(block, `generateAll 没归一化 ${o}`).toContain(`${o}:`);
    }
  });

  it("_composeFinalVideo 的 opts 必须覆盖每一个出片选项", () => {
    // 这是最容易漏的一层：generateAll 收到了、orchestrator 也传了，
    // 但 compose 的 opts 是手写对象，漏一个就等于该选项不存在。
    const at = gen.indexOf("await this._composeFinalVideo(");
    expect(at, "找不到 _composeFinalVideo 调用").toBeGreaterThan(-1);
    const block = gen.slice(at, at + 1400);
    for (const o of options) {
      expect(block, `_composeFinalVideo 没传 ${o} —— 这正是之前封面/藏带货不生效的原因`).toContain(
        `${o}: opts.${o}`
      );
    }
  });

  it("needsCompose 必须把拼接类需求算进去", () => {
    // 用户传了封面图却直接拿粗剪当成片，成片看起来完全正常，
    // 只是首帧没有封面 —— 这类"静默不生效"最难发现
    const at = gen.indexOf("const needsCompose");
    const block = gen.slice(at, at + 600);
    expect(block).toMatch(/opts\.coverImage && opts\.coverImage\.usePath/);
    expect(block).toMatch(/opts\.tailVideo && opts\.tailVideo\.usePath/);
  });

  it("options 列表本身要和类型契约对齐", () => {
    const types = read("src/shared/api-types.ts");
    const roBlock = types.slice(types.indexOf("export interface RenderOptions {"), types.indexOf("export interface CaptionStyle"));
    for (const o of options) {
      expect(roBlock, `RenderOptions 里没有 ${o}`).toMatch(new RegExp(`\\b${o}\\??:`));
    }
  });
});

describe("素材库 UI", () => {
  const picker = read("src/renderer/src/components/AssetPicker.tsx");
  const style = read("src/renderer/src/components/FontStylePanel.tsx");
  const ro = read("src/renderer/src/components/RenderOptions.tsx");
  const wb = read("src/renderer/src/components/Workbench.tsx");

  it("封面和藏带货要在出片选项里各自成块", () => {
    expect(ro).toMatch(/<AssetPicker\s+kind="covers"/);
    expect(ro).toMatch(/<AssetPicker\s+kind="tails"/);
    expect(ro).toMatch(/上传封面图/);
    expect(ro).toMatch(/结尾藏带货/);
  });

  it("样式面板要能预览当前值", () => {
    // 面板本身要提供这些控件，RenderOptions 要真的把它渲染出来
    expect(ro).toMatch(/<FontStylePanel/);
    for (const l of ["字体", "颜色", "字号", "位置", "描边", "阴影"]) {
      expect(style, `样式面板缺「${l}」控件`).toContain(`label="${l}"`);
    }
  });

  it("位置用预设而不是让用户填像素", () => {
    // 竖屏 1080x1920 和横屏 1080x608 的"顶部"不是同一个 y 值，
    // 让用户自己填像素必然要返工
    expect(style).toMatch(/顶部/);
    expect(style).toMatch(/居中/);
    expect(style).toMatch(/底部/);
  });

  it("必须支持批量上传和批量删除", () => {
    // 用户手里的封面图/带货片段都是一批的，逐个传没法用
    expect(picker).toMatch(/assetImport\(kind, true\)/);
    expect(picker).toMatch(/全选/);
    expect(picker).toMatch(/assetDelete\(kind, ids\)/);
    // 删除必须能恢复
    expect(picker).toMatch(/assetRestore\(kind\)/);
    expect(picker).toMatch(/恢复/);
  });

  it("勾选和选用要分开", () => {
    // 勾选=批量管理时选中；选用=出片用这张。混成一个会让用户
    // 以为勾了就会用在成片里
    expect(picker).toMatch(/勾选（用于批量删除）/);
    expect(picker).toMatch(/出片时用这张/);
  });

  it("缩略图走主进程白名单，且卸载时释放", () => {
    // 不能直接读本地路径（contextIsolation 拿不到 file://）；
    // 不释放会让白名单一直占着
    expect(picker).toMatch(/mediaOpen\(it\.path\)/);
    expect(picker).toMatch(/mediaClose\(p\)/);
  });

  it("出片前必须解析实际用的素材并回显", () => {
    // 随机策略只能在这里落定；不回显的话用户看到的和烧进片子的不是一回事
    expect(wb).toMatch(/assetPick\("covers"/);
    expect(wb).toMatch(/assetPick\(\s*\n?\s*"tails"/);
    expect(wb).toMatch(/封面首帧「\$\{cover\.name\}」/);
    expect(wb).toMatch(/结尾藏带货「\$\{tail\.name\}」/);
  });

  it("素材被删要说明，不能静默出一片没封面的片子", () => {
    expect(wb).toMatch(/本次没加首帧/);
    expect(wb).toMatch(/本次没加尾巴/);
  });

  it("封面图那几秒是静音的，要写进界面", () => {
    // 不写清楚的话用户会以为封面自带声音
    expect(ro).toMatch(/封面图那几秒是静音的/);
  });

  it("文案位置默认值是中下(0.68)", () => {
    expect(ro).toMatch(/textY \?\? 0\.68/);
  });
});

describe("引擎设置面板", () => {
  const main = read("src/main/index.ts");
  const app = read("src/renderer/src/App.tsx");
  const preload = read("src/preload/index.ts");
  const wb = read("src/renderer/src/components/Workbench.tsx");

  it("保存必须同步进 Hermes 配置,否则存了也不生效", () => {
    // Hermes 只读 config/default.json,GLB 自己的 engine-settings.json 它根本不看。
    // 只写自己那份的话,用户填了 Key 点了保存,分析时依然报"key 缺失"。
    expect(main).toMatch(/syncHermesEngineConfig/);
    expect(main).toMatch(/hermesSynced/);
  });

  it("provider 必须翻成 Hermes 认的值", () => {
    // 面板写 local/cloud,Hermes 只认 ollama/gemini。漏翻的话 Hermes 会
    // 去找一个叫 "cloud" 的 provider,然后静默落到本地 —— 和 auto 之前同一个坑。
    expect(main).toMatch(/=== "cloud" \? "gemini" : .*=== "local" \? "ollama" : "auto"/);
  });

  it("必须能选默认引擎,不能只能被动接受自动", () => {
    // 面板文案一直说"按素材形态自动分派",但 defaultEngine 曾经根本不能改。
    expect(app).toMatch(/defaultEngine/);
    expect(app).toMatch(/只用本地/);
    expect(app).toMatch(/只用云端/);
  });

  it("保存后要提示需要重启,否则用户以为设置没生效", () => {
    // createLlmClient 在 Orchestrator 构造时就固定了,改配置不会热加载。
    expect(app).toMatch(/重启 Hermes 后生效/);
  });

  it("选了云端却没 Key 要拦下来", () => {
    // 不拦的话会"保存成功但永远走本地",比报错更难排查。
    expect(app).toMatch(/defaultEngine === "cloud"/);
  });

  it("要有连通性检测,不能存完只能靠猜", () => {
    expect(main).toMatch(/engine:test/);
    expect(preload).toMatch(/testEngines/);
    expect(app).toMatch(/检测连通/);
  });

  it("设置入口必须在剪辑台里够得着", () => {
    // 入口只在启动页的话,进了剪辑台就改不了引擎,而改引擎是剪辑前必做的事。
    expect(wb).toMatch(/onOpenSettings/);
    expect(wb).toMatch(/LuSettings/);
    expect(app).toMatch(/<Workbench engine=\{engine\} onOpenSettings=/);
  });

  it("探测 Ollama 用 /api/tags 而不是 v1 路径", () => {
    // Ollama 的原生接口不带 /v1;Hermes 每次请求前都会 replace('/v1',''),
    // 这里照做,否则永远探测不到模型列表。
    expect(main).toMatch(/replace\(\/\\\/v1\\\/\?\$\/, ""\)/);
    expect(main).toMatch(/\/api\/tags/);
  });
});

describe("撤销/重做", () => {
  const store = read("src/renderer/src/stores/session-store.ts");
  const hooks = read("src/renderer/src/hooks/useShortcuts.ts");
  const wb = read("src/renderer/src/components/Workbench.tsx");

  it("打回意见必须记到当前 IP 名下(否则历史评审经验不生效)", () => {
    // 以前 addReviewFeedback 不传 collection,回落到 store.activeCollection。
    // 那时桌面端还没和 activeCollection 联动,所以所有意见都落 collection=NULL,
    // 而 getCollectionAvoidRules 只按集合查 —— 用户明明说过"钩子不够炸",
    // 分析时却完全不生效。
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    const handler = orch.slice(orch.indexOf("'/highlight/reject'"), orch.indexOf("'/highlight/reject'") + 3000);
    // 打回与指定开头两个分支都要带
    const hits = handler.match(/collection: this\.store\.activeCollection \|\| null/g);
    expect(hits?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 看板审阅走辅助方法
    expect(orch).toMatch(/_collectionOfLiveVideo\(project\.live_video_id\)/);
  });

  it("剪辑归档必须按直播素材自身的 IP 记,不能只看当前选中的 IP", () => {
    /*
     * 这条测试原来断言的是反过来的结论:"live_videos 没有 collection 列,不能从素材推 IP"。
     * 那个前提现在变了 —— live_videos 已经有 collection 列,而且必须用它。
     *
     * 为什么改:审片往往发生在分析几天之后,那时用户早就切到别的 IP 了。
     * 继续用 activeCollection,案例老师的口播删减会被记到李老师名下,
     * 而且不报错,错误规则会持续累积。
     */
    const store = readFileSync("D:/GLB/Hermes/src/memory/store.js", "utf8");
    const ownerIdx = store.indexOf("_ownerOfLive(liveVideoId) {");
    expect(ownerIdx).toBeGreaterThan(-1);
    // 必须先查素材自身的 collection
    expect(store.slice(ownerIdx, ownerIdx + 600)).toMatch(/SELECT collection FROM live_videos/);
    // 查不到才回落当前选中,两者都没有就 null(不猜)
    const body = store.slice(ownerIdx, store.indexOf("getEditArchive(", ownerIdx));
    expect(body).toMatch(/return this\.activeCollection \|\| null/);

    // 改名要搬全部四张表,否则归档断裂(只搬 hit_videos 是原来的 bug)
    const renameIdx = store.indexOf("renameCollection(oldName, newName) {");
    expect(renameIdx).toBeGreaterThan(-1);
    const rename = store.slice(renameIdx, store.indexOf("deleteCollectionRecord(", renameIdx));
    for (const t of ["hit_videos", "live_videos", "review_feedback", "review_edits"]) {
      expect(rename).toContain(t);
    }
  });

  it("避雷规则与指令类意见必须分开", () => {
    // "指定新开头重找"是指令,由 isRevocation 单独处理;
    // 混进 avoid 会让模型把它当成"不要重找开头",完全反了。
    const live = readFileSync("D:/GLB/Hermes/src/analyzer/live-analyzer.js", "utf8");
    expect(live).toMatch(/mem\.avoid = mem\.feedback\.filter/);
    expect(live).toMatch(/不要\|别\|避免\|太慢\|不好\|没人看/);
  });

  it("撤销/重做必须区分用户操作与系统行为", () => {
    // 重新分析后 AI 重排勾选、打开项目恢复 —— 这些是系统行为,
    // 不该进历史。否则用户按撤销只会退回到"AI 上次怎么排的",
    // 而不是"我自己刚才改错了什么"。
    expect(store).toMatch(/setSelected: \(selected: Set<number>, action\?: string\)/);
    expect(store).toMatch(/if \(action\) get\(\)\.record\(action\)/);
  });

  it("历史存的是改之前的状态", () => {
    // 先 record 再 set。反了就变成"撤销 = 再做一次",完全反了。
    expect(store).toMatch(/toggleSelected: \(id, action\) => \{\s*if \(action\) get\(\)\.record\(action\);\s*set\(/);
    expect(store).toMatch(/patchCandidate: \(id, patch, action\) => \{[\s\S]{0,120}if \(action\) get\(\)\.record\(action\);[\s\S]{0,120}set\(/);
  });

  it("切换工作对象必须清空历史", () => {
    // 换素材/打开项目/重置 = 换了一个工作对象,旧历史全部作废
    expect(store).toMatch(/setFile:[\s\S]{0,320}history: \{ past: \[\], future: \[\] \}/);
    expect(store).toMatch(/restore:[\s\S]{0,700}history: \{ past: \[\], future: \[\] \}/);
    expect(store).toMatch(/reset:[\s\S]{0,140}history: \{ past: \[\], future: \[\] \}/);
  });

  it("撤销只记录用户自己的编辑决策", () => {
    // 播放位置/焦点/加载状态进历史会把栈填满噪声,
    // 用户按撤销只看到"焦点变了"这种没意义的回退。
    const snap = store.slice(store.indexOf("interface EditSnapshot"), store.indexOf("interface EditSnapshot") + 300);
    expect(snap).toMatch(/selected: number\[\]/);
    expect(snap).toMatch(/candidates: ClipCandidate\[\] \| null/);
    expect(snap).not.toMatch(/focusedId|playTime|stage/);
  });

  it("Ctrl+Z 必须拦在放行 Ctrl 组合之前", () => {
    // 放在"Ctrl/Alt/Meta 不拦截"那行之后就永远按不到。
    // 这是行业惯例,用户不看说明也会去按。
    const undoIdx = hooks.indexOf('get().onUndo?.()');
    const passIdx = hooks.indexOf("if (e.ctrlKey || e.altKey || e.metaKey) return;");
    expect(undoIdx).toBeGreaterThan(-1);
    expect(passIdx).toBeGreaterThan(-1);
    expect(undoIdx).toBeLessThan(passIdx);
    // Ctrl+Y 也是重做(Vim/Windows 常见)
    expect(hooks).toMatch(/k === "y"/);
    expect(hooks).toMatch(/e\.shiftKey\) get\(\)\.onRedo/);
  });

  it("按钮 disabled 时保留位置,不隐藏", () => {
    // 按钮忽然出现/消失会让用户以为自己记错了快捷键位置
    expect(wb).toMatch(/disabled=\{!session\.canUndo\}/);
    expect(wb).toMatch(/disabled=\{!session\.canRedo\}/);
    // 标题要显示"撤销:xxx",让用户知道会撤掉什么
    expect(wb).toMatch(/撤销:\$\{session\.lastAction\}/);
  });

  it("每个用户操作都要给出可读说明", () => {
    expect(wb).toMatch(/"勾选变化"/);
    expect(wb).toMatch(/"修改候选"/);
    expect(wb).toMatch(/"全选"/);
    expect(wb).toMatch(/"只留高分"/);
  });
});

describe("记忆必须按 IP 隔离(选谁学谁)", () => {
  const store = readFileSync("D:/GLB/Hermes/src/memory/store.js", "utf8");
  const live = readFileSync("D:/GLB/Hermes/src/analyzer/live-analyzer.js", "utf8");

  it("必须有按集合取记忆的入口", () => {
    // 以前 getStyleProfile() 返回 user_style_profile 全表,
    // 那些 hooks_<genre> 是跨 IP 混合的全局钩子池。
    // 用户选哪位老师都不影响结果 —— 界面不报错,但模型学的是所有人的混合体。
    expect(store).toMatch(/getCollectionHooks\(/);
    expect(store).toMatch(/getCollectionThemeKeywords\(/);
    expect(store).toMatch(/getCollectionAvoidRules\(/);
    expect(store).toMatch(/getCollectionHits\(/);
  });

  it("只认 completed 的爆款", () => {
    // skipped/failed 没有结构数据,混进来只会污染记忆
    expect(store).toMatch(/analysis_status = 'completed'/);
  });

  it("空集合名必须返回空,不能回落全局池", () => {
    // 回落会让"没设集合"看起来像"用了某套记忆",是假象
    const fns = ["getCollectionHooks", "getCollectionThemeKeywords", "getCollectionAvoidRules", "getCollectionHits"];
    for (const f of fns) {
      const body = store.slice(store.indexOf(`${f}(`));
      expect(body.slice(0, 220)).toMatch(/if \(!name\) return \[\]/);
    }
  });

  it("live-analyzer 必须优先用本集合的钩子", () => {
    const hookBlock = live.slice(live.indexOf("① 开场钩子句式"), live.indexOf("② 每条历史爆款"));
    // 先取自己的,取不到才回落 genre 池。顺序反了就是"学错人"。
    expect(hookBlock).toMatch(/if \(active\)/);
    expect(hookBlock).toMatch(/getCollectionHooks\?\.\(active/);
    expect(hookBlock).toMatch(/if \(!picked\)/);
  });

  it("主题和打回意见也必须按集合", () => {
    expect(live).toMatch(/getCollectionThemeKeywords\?\.\(active/);
    expect(live).toMatch(/getCollectionAvoidRules\?\.\(active/);
    // 不能在有集合时还读全局 review_feedback
    const fb = live.slice(live.indexOf("mem.feedback = active"));
    expect(fb.slice(0, 260)).toMatch(/getCollectionAvoidRules/);
  });

  it("必须有记忆快照端点(否则切了没换这件事无法验证)", () => {
    // active-collection 设对了 != 分析时真的换了记忆,中间隔着注入逻辑。
    // 而 Hermes 的 stdout 不落盘,翻日志验不了 —— 只能让服务把
    // "现在真正会注入什么"摊出来。
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    expect(orch).toMatch(/'\/api\/memory-snapshot'/);
    const h = orch.slice(orch.indexOf("'/api/memory-snapshot'"), orch.indexOf("'/api/llm-status'"));
    expect(h).toMatch(/getCollectionHooks/);
    expect(h).toMatch(/getCollectionThemeKeywords/);
    expect(h).toMatch(/source: active \? 'collection' : 'none'/);
  });
});

describe("爆款记忆库", () => {
  const vault = read("src/main/vault.ts");
  const ipc = read("src/main/vault-ipc.ts");
  const preload = read("src/preload/index.ts");
  const types = read("src/shared/api-types.ts");
  const panel = read("src/renderer/src/components/HitVaultPanel.tsx");
const picker = read("src/renderer/src/components/IpPicker.tsx");
  const wb = read("src/renderer/src/components/Workbench.tsx");
  const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");

  it("每个 IP 必须是独立文件夹", () => {
    // 用户明确要求"区分每一个 IP 老师单独一个文件夹"
    expect(vault).toMatch(/function ipDir\(userData: string, ipId: string\)/);
    expect(vault).toMatch(/join\(rootOf\(userData\), safeSegment\(ipId\)\)/);
  });

  it("目录名必须净化,防路径穿越", () => {
    // ipId 会拼进磁盘路径,带 ../ 就写到别处去了
    expect(vault).toMatch(/function safeSegment/);
    expect(vault).toMatch(/replace\(\/\[\^\\w一-龥\.\-\]\/g, "_"\)/);
  });

  it("同名 IP 必须拒绝(否则两个文件夹抢同一套记忆)", () => {
    expect(vault).toMatch(/if \(ips\.some\(\(i\) => i\.name === trimmed\)\) return null;/);
    // 重命名时也要挡(但要排除自己)
    expect(vault).toMatch(/i\.name === trimmed && i\.id !== ipId/);
  });

  it("JSON 必须原子写,否则断电会留下半个文件", () => {
    // 直接覆盖时中途断电 -> parse 失败 -> fallback -> 用户以为数据被清空
    expect(vault).toMatch(/async function writeJsonAtomic/);
    expect(vault).toMatch(/writeFile\(tmp,[\s\S]{0,80}rename\(tmp, path\)/);
  });

  it("校准必须用中位数,且结论可追溯", () => {
    // 爆款数据长尾,均值会被单条异常值绑架
    expect(vault).toMatch(/const median = /);
    expect(vault).toMatch(/contributing/);
  });

  it("撤回要同时清索引和磁盘文件", () => {
    expect(vault).toMatch(/async function undoBatch/);
    // 不删 clips 下的文件会留孤儿,下次导入产生重复
    expect(vault).toMatch(/rm\(join\(ipDir\(userData, ipId\), "clips", `\$\{e\.id\}\.json`\), \{ force: true \}\)/);
  });

  it("恢复误删时目标目录必须先删,否则 Windows rename 会失败", () => {
    // 实测踩过:先 mkdir 再 rename,目录移不回去,界面表现为"点了没反应"
    const fn = vault.slice(vault.indexOf("export async function restoreLastDeletedIp"));
    expect(fn).toMatch(/await rm\(dest, \{ recursive: true, force: true \}\)/);
    const renameIdx = fn.indexOf("await rename(dir, dest)");
    const rmIdx = fn.indexOf("await rm(dest");
    expect(rmIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeLessThan(renameIdx);
  });

  it("只同步 completed 的爆款", () => {
    // skipped/failed 没有结构数据,导进来只会污染校准
    const h = orch.slice(orch.indexOf("'/api/hits/export'"), orch.indexOf("'/hits/:id/cover'"));
    expect(h).toMatch(/analysis_status = 'completed'/);
  });

  it("没有真实播放数据时不能编造", () => {
    // hit_performance 是空表,填 0 会被当成"零播放"
    const h = orch.slice(orch.indexOf("'/api/hits/export'"), orch.indexOf("'/hits/:id/cover'"));
    expect(h).toMatch(/performance: perf/);
    expect(ipc).toMatch(/views: perf\?\.views \?\? undefined/);
  });

  it("指标必须从内容客观推导,不能写死常数", () => {
    // 写死 0.8 之类的常数等于把没验证的先验当成从数据学出来的结论
    expect(ipc).toMatch(/infoDensity = sec > 0 \?/);
    expect(ipc).toMatch(/const emotion = median/);
    expect(ipc).toMatch(/Number\.isFinite\(Number\(hookIntensity\)\)/);
  });

  it("同步要按集合分 IP,并给未归集合的兜底", () => {
    // Hermes 的 collection 本来就是按老师分的,直接沿用
    expect(ipc).toMatch(/String\(h\.collection \|\| ""\)\.trim\(\) \|\| "未分类"/);
  });

  it("选 IP 必须同时切 Hermes 的 active collection", () => {
    // 不切的话 /memory-brief 永远算的是上次那个集合,
    // 表现为"界面选了案例老师,实际用别的老师",且不报错
    expect(ipc).toMatch(/hit:activateIp/);
    expect(ipc).toMatch(/active-collection/);
    expect(wb).toMatch(/hitActivateIp/);
  });

  it("新建 IP 必须同时在 Hermes 建同名 collection", () => {
    /*
     * 只建本地文件夹是不够的：Hermes 里没有这个 collection，
     * 之后所有学习样本都按"没有归属"落库 ——
     * 表现是该老师的记忆永远空白，而且全程不报错。
     *
     * 对应关系是 name（不是本地 uuid）：
     * Hermes 的 /memory-brief、review_edits.collection、
     * hotwords.collection 全都按名字归属。
     */
    expect(ipc).toMatch(/hit:createIp[\s\S]{0,900}?\/api\/collections/);
    expect(ipc).toMatch(/hermesSynced/);
  });

  it("Hermes 侧没建成功时不能报'已建好',也不能悄悄回滚本地 IP", () => {
    // 本地文件夹是界面的真相，删了反而会丢用户刚建的档案；
    // 但必须把失败如实说出来，否则记忆为空却毫无提示。
    expect(panel).toMatch(/hermesSynced/);
    expect(picker).toMatch(/hermesSynced/);
  });

  it("Hermes brief 对不上时要返回空,不能拿别的老师的记忆冒充", () => {
    expect(ipc).toMatch(/brief\?\.collection !== ip\.name/);
  });

  it("双击 IP 必须能打开 ta 的爆款记忆素材库", () => {
    /*
     * 爆款库面板原本只挂在 Workbench 上，而 Workbench 只在"已经有素材"时才出现，
     * 于是"上传前想看看某位老师已经积累了什么"根本没有入口 ——
     * 用户只能从左边导航进爆款库再自己找是哪一位，明明名字就在眼前。
     */
    const picker = read("src/renderer/src/components/IpPicker.tsx");
    const stage = read("src/renderer/src/components/ImportStage.tsx");
    expect(picker).toMatch(/onDoubleClick/);
    // 上传页自己得能渲染爆款库，不能只靠出片台
    expect(stage).toMatch(/HitVaultPanel/);
    expect(stage).toMatch(/vaultIpId/);
    // 在库里换 IP 要同步这一页的 collection，否则两边显示不一致
    expect(stage).toMatch(/setCollection\(ip\.name\)/);
    // 双击提示要写出来，否则用户不知道名字旁边就能进去
    expect(picker).toMatch(/双击打开/);
  });

it("热词更正必须在出片台，不能放在爆款记忆库里", () => {
    /*
     * 热词是"干活时的工具"：用户正在看逐句稿、准备粗剪出片，
     * 看到错字当场改，改完这一片立刻生效。
     * 放在爆款记忆库里等于让人翻档案去改一个字 ——
     * 而且那里根本没有文案可对照，改完也看不出效果。
     */
    const vault = read("src/renderer/src/components/HitVaultPanel.tsx");
    const wb2 = read("src/renderer/src/components/Workbench.tsx");
    // 爆款库里不许再挂
    expect(vault).not.toMatch(/<HotwordPanel/);
    // 出片台要挂在逐句稿旁边，并把当前文案传进去算命中次数
    expect(wb2).toMatch(/<HotwordPanel/);
    expect(wb2).toMatch(/collection=\{memoryIpName \?\? null\}/);
    expect(wb2).toMatch(/sampleText=\{.*segments/);
  });

it("每条爆款素材都要能看到爆款预测，且必须标出是估的", () => {
    /*
     * 以前 /api/hits/export 只导 performance 不导 prediction，
     * 于是桌面端明明有 hit_predictions 表、也有 /hits/:id/predict 可手动重算，
     * 却永远看不到预测值 —— 只能去 Hermes 自己的看板上看。
     */
    const ipc3 = read("src/main/vault-ipc.ts");
    const types3 = read("src/shared/api-types.ts");
    const panel3 = read("src/renderer/src/components/HitVaultPanel.tsx");
    // 查预测的 SQL 在 Hermes 侧的 orchestrator 里，不在 clipper
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    expect(orch).toMatch(/FROM hit_predictions WHERE hit_video_id/);
    // 预测不能塞进 metrics：那边是回流真实数，混起来用户会当参考
    expect(types3).toMatch(/prediction\?: \{/);
    expect(ipc3).toMatch(/prediction: h\.prediction \?\? null/);
    // 界面上要显示把握度和依据
    expect(panel3).toMatch(/预测/);
    expect(panel3).toMatch(/把握/);
  });

it("预测不准要能用截图更正，并重算预测", () => {
    const dlg = read("src/renderer/src/components/HitFeedbackDialog.tsx");
    const ipc4 = read("src/main/vault-ipc.ts");
    // 桌面端只送图，OCR 与重算都交给 Hermes —— 两边各做一套只会得到两套读数
    expect(ipc4).toMatch(/\/hits\/\$\{hitId\}\/feedback/);
    expect(dlg).toMatch(/hitFeedback/);
    // 截图要先压图，否则必然超 express.json 的 15mb 上限
    expect(dlg).toMatch(/toDataURL\("image\/jpeg"/);
    // OCR 结果只回填输入框让用户核对，不能悄悄当事实写库
    expect(dlg).toMatch(/请核对/);
    // 没有 Hermes 侧 id 要明确提示，不能假装成功
    expect(dlg).toMatch(/还没同步到 Hermes/);
  });

it("更正返回的预测必须归一化成驼峰", () => {
    /*
     * Hermes 的 /hits/:id/feedback 返回的是库里原样字段（views_low/views_high），
     * 而桌面端其他字段全是驼峰。混着给的话，
     * 调用方读 prediction.viewsLow 得到 undefined，
     * 而 undefined !== 任何数 恒成立 ——
     * "预测有没有被重算"永远判 true，界面一直说"已重算"，实际区间没读到。
     */
    const ipc5 = read("src/main/vault-ipc.ts");
    expect(ipc5).toMatch(/raw\.viewsLow \?\? raw\.views_low/);
    expect(ipc5).toMatch(/numOrNull/);
  });

it("重复同步必须刷新已有条目的预测，不能静默跳过", () => {
    /*
     * 以前 seen 集合命中就 skipped++ 走人 ——
     * 于是 Hermes 侧后来补上的 prediction / performance 永远同步不过来。
     * 用户点「从历史爆款库同步」，界面上的预测一直不变，
     * 看起来像同步没生效，而 syncFromHermes 还返回 ok:true。
     *
     * 去重键还必须归一化路径分隔符：同一个文件在 Windows 上
     * 可能是 D:\a\b.mp4 也可能是 D:/a/b.mp4，
     * 原样比较会插出重复条目，两份都会进画像把中位数算歪。
     */
    const vault2 = read("src/main/vault.ts");
    expect(vault2).toMatch(/normKey/);
    expect(vault2).toMatch(/prediction: raw\.prediction \?\? prev\.prediction/);
    expect(vault2).toMatch(/refreshed/);
    // 合并去重，否则刷新过的条目会和旧版本同时存在于索引里
    expect(vault2).toMatch(/byKey\.set/);
  });

it("所有子进程都必须 windowsHide，否则会弹黑框抢焦点", () => {
    /*
     * 2026-10-05 的灾难性 bug：用户批量上传素材到记忆库，
     * 黑框反复弹出、抢占最上层、电脑变得很卡。
     *
     * 根因：ffmpeg / ffprobe / sherpa-asr 在 Windows 上都是**控制台程序**，
     * spawn/execFile 时不带 windowsHide 就会每调用一次弹一个黑框。
     * 批量上传 N 个素材 = 每条要跑好几次 ffmpeg + 桌面端每文件一次 ffprobe
     * = 黑框刷屏。而底下那些 taskkill 早就设了 windowsHide，唯独主 spawn 漏了，
     * 所以现象是"杀进程不弹、分析本身狂弹"。
     *
     * 两边都得锁：Hermes 侧的 ffmpeg/asr，以及桌面端的 ffprobe。
     */
    const main = read("src/main/index.ts");
    expect(main).toMatch(/maxBuffer: 8 \* 1024 \* 1024, windowsHide: true/);
    // 代理查询那处本来就有，一并锁住
    expect(main).toMatch(/encoding: "utf8",\s*\n\s*windowsHide: true/);

    const ff = readFileSync("D:/GLB/Hermes/src/analyzer/ffmpeg-helper.js", "utf8");
    const asr = readFileSync("D:/GLB/Hermes/src/analyzer/asr-helper.js", "utf8");
    // 主 spawn（不是 taskkill）必须有 windowsHide
    expect(ff).toMatch(/spawn\(cmd, args, \{ shell: false, windowsHide: true \}\)/);
    expect(ff).toMatch(/\{ shell: false, windowsHide: true \}/);
    expect(asr).toMatch(/spawn\(cmd, args, \{ shell: false, windowsHide: true \}\)/);
});

it("「确认通过」不能静默丢掉待生效的文字删除", () => {
  /*
   * 以前 ReviewPanel 里 approve 分支直接把 textCuts 丢掉并 setTextCuts([])，
   * 而底部说明写着"随打回一起生效"，且"确认通过"按钮就紧挨在"打回"旁边。
   * 一次误点，框了半天选中的字全部消失，界面一个字都没提。
   */
  const rp = read("src/renderer/src/components/ReviewPanel.tsx");
  expect(rp).toMatch(/confirmApproveWithCuts/);
  expect(rp).toMatch(/确认通过会丢掉这些文字删除/);
  // 必须给出"改用打回"这个出路，而不只是取消
  expect(rp).toMatch(/改用「打回重剪」/);
});

it("通过回执必须如实反映学习有没有写成", () => {
  /*
   * 服务端把整个正样本写入包在 try 里，抛错时"通过"照样成立。
   * 界面以前无条件显示"下次找爆点会参考这次的意见" —— 失败时说的正好是反的。
   */
  const rp2 = read("src/renderer/src/components/ReviewPanel.tsx");
  expect(rp2).toMatch(/r\.learnFailed/);
  expect(rp2).toMatch(/这次的意见没记进去/);
  // 作废工程被拒时不能继续往下走
  expect(rp2).toMatch(/supersededBy/);
});

it("UI 要能完成全流程:新建/重命名/删除/恢复/写入记忆/批量导入/撤回/删单条", () => {
    /*
     * "写入记忆"这一项原来断言的是"从历史爆款库同步"。
     * 2026-10-06 改了文案：那个名字和出片台的"按记忆重找爆款"撞在
     * "爆款"两个字上，方向却相反（一个写入记忆库，一个读取记忆），
     * 用户以为导入后没变化就是这个按钮造成的。
     * 新文案用动词"写入"把方向说死。
     */
    for (const s of ["新建", "重命名", "删除", "恢复误删", "把已分析结果写入记忆库", "批量导入", "撤回"]) {
      expect(panel).toContain(s);
    }
    // 读记忆的那个按钮必须用"用爆款记忆…"的说法，和写记忆的"写入记忆库"
    // 措辞完全不同 —— 两个都带"爆款记忆"，方向却相反，用户最容易在这里分不清。
    const dockSrc = read("src/renderer/src/components/ExportDock.tsx");
    expect(dockSrc).toContain("用爆款记忆重挑片段");
    expect(panel).toContain("把已分析结果写入记忆库");
    expect(panel).toMatch(/hitUndoBatch/);
    expect(panel).toMatch(/hitDeleteEntry/);
  });

it("「用这套记忆」必须贴在 IP 卡片旁边，不能再埋在画像栏底部", () => {
    /*
     * 回归：原来这个按钮放在右侧画像栏最底部（mt-auto 推下去）。
     * 画像一长它就被埋到看不见的地方，用户反馈"藏得太深"。
     * 选哪位老师和应用哪位老师的记忆本来就是同一个动作的两步，
     * 所以按钮就该贴在对应卡片右边。
     *
     * 断言跑在剥掉注释的代码上：注释里提到「用这套记忆」和 mt-auto，
     * 直接在原文里搜会被自己的说明文字匹配上。
     * 锚点用 onPickIp?.(x)，只有卡片上那个按钮会用。
     */
    const code = stripComments(panel);
    const ipMapIdx = code.indexOf("ips.map");
    const cardBtnIdx = code.indexOf("onPickIp?.(x)");
    expect(ipMapIdx, "没找到 IP 列表").toBeGreaterThan(-1);
    expect(cardBtnIdx, "IP 卡片上应该有一个直接应用记忆的按钮").toBeGreaterThan(ipMapIdx);

    // 画像栏底部那个 mt-auto 版本必须已经拿掉，否则同一个动作有两个入口
    expect(code).not.toMatch(/mt-auto[^"]*"[\s\S]{0,200}用这套记忆/);

    // 不能出现「外层 button 里再套 button」—— 无效 HTML，点击会被报给外层
    expect(code).not.toMatch(/<button[^>]*>\s*(?:(?!\/button)[\s\S])*?<button/);
  });

  it("IP 的新建/重命名/删除要贴在「IP 老师」标题下面，不能沉到栏底", () => {
    /*
     * 回归：这组三个原来在左栏最底部（mt-auto 推下去），
     * 列表一长就看不见 —— 和「用这套记忆」当初埋在画像栏底部一个毛病。
     * 挪上去还有个理由：它们作用的对象就是下面那张卡片列表，
     * 紧挨着才说得清对谁生效。
     */
    const code = stripComments(panel);
    const headerIdx = code.indexOf("IP 老师");
    expect(headerIdx, "没找到 IP 老师标题").toBeGreaterThan(-1);

    for (const name of ["新建", "重命名", "删除"]) {
      // 容许换行缩进：源码里 `>` 和文字往往不在同一行
      const re = new RegExp(`>\\s*${name}\\s*</button>`);
      const m = re.exec(code);
      expect(m, `没找到「${name}」按钮`).not.toBeNull();
      expect(m!.index, `「${name}」应该在「IP 老师」标题之后`).toBeGreaterThan(headerIdx);
    }

    // mt-auto 是「推到容器最底」的类名，这三个按钮身上不该再有
    const start = code.search(/>\s*新建\s*<\/button>/);
    const end = code.search(/>\s*删除\s*<\/button>/);
    expect(code.slice(start - 500, end + 200), "IP 操作按钮不该再用 mt-auto 沉底").not.toContain("mt-auto");
  });

  it("左导航要有爆款库入口,并显示当前用的老师", () => {
    expect(wb).toMatch(/onOpenVault=\{openVault\}/);
    expect(wb).toMatch(/memoryIpName=\{memoryIpName\}/);
    expect(wb).toMatch(/爆款库/);
  });

  it("桥接要全(声明了但主进程没注册 = 永远拿不到方法)", () => {
    for (const m of [
      "hitListIps", "hitCreateIp", "hitRenameIp", "hitDeleteIp", "hitRestoreIp",
      "hitListEntries", "hitImport", "hitImportFiles", "hitListBatches",
      "hitUndoBatch", "hitDeleteEntry", "hitProfile", "hitRebuildProfile",
      "hitProfileBrief", "hitSyncFromHermes", "hitActivateIp", "hitHermesBrief"
    ]) {
      expect(types).toContain(m);
      expect(preload).toContain(m);
    }
  });
});

describe("验证脚本不许污染用户数据", () => {
  const scriptsDir = "scripts";

  it("成片列表必须过滤测试素材产物", () => {
    // 真实事故:verify:wrap / verify:variant-* 都走真实出片链路,
    // 在库里堆了几十个测试 clip_project。成片列表按 id 倒序,
    // 这些记录正好排在最前面 —— 用户打开界面看到的第一批全是测试视频,
    // 其中 21KB 那个还是彩条测试图,看起来像程序坏了。
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    const h = orch.slice(orch.indexOf("'/api/outputs'"), orch.indexOf("'/api/system'"));
    expect(h).toMatch(/test-live\|_vo_test\|_mv_test/);
    expect(h).toMatch(/\.filter\(/);
  });

  it("走了真实出片链路的验证脚本必须收尾清理", () => {
    const dirty = [
      "verify-opening.cjs",
      "verify-wrap.cjs",
      "verify-variant-pick.cjs",
      "verify-variant-opening-toggle.cjs"
    ];
    for (const f of dirty.filter((x) => !scriptMissing(x))) {
      const src = readFileSync(`${scriptsDir}/${f}`, "utf8");
      expect(src).toMatch(/cleanupAfterVerify/);
    }
  });

  it("清理只认明确的测试素材名,不能碰真实素材", () => {
    const cleanup = readFileSync(`${scriptsDir}/cleanup-test-data.cjs`, "utf8");
    // 必须用白名单式的具体名字,不能用 /test/ 这种宽匹配
    // —— 否则真实素材里带 test 的会被连带删掉。
    expect(cleanup).toMatch(/test-live-01\|_vo_test\|_mv_test/);
    expect(cleanup).not.toMatch(/\/test\/i/);
    // 默认干跑,必须显式 --apply
    expect(cleanup).toMatch(/process\.argv\.includes\("--apply"\)/);
  });

  it("磁盘清理要放过混了真实文件的目录", () => {
    const draft = readFileSync(`${scriptsDir}/cleanup-draft.cjs`, "utf8");
    expect(draft).toMatch(/混了非测试文件/);
    expect(draft).toMatch(/continue;/);
  });
});

describe("多版本选定后能真的出片", () => {
  const client = read("src/main/hermes-client.ts");
  const wb = read("src/renderer/src/components/Workbench.tsx");
  const panel = read("src/renderer/src/components/VariantPanel.tsx");

  it("出片台必须有明确的返回上传页入口", () => {
    /*
     * 以前唯一能回去的是左边那个橙色按钮，它直接 session.reset() 且不提示：
     * 看着像"再加一个素材"，实际把刚分析出来的成果全丢掉。
     * 于是没人敢点，出片台就成了没有出口的死胡同 —— 用户报"没有返回方式"。
     * 锁住三处入口，避免以后又被当成冗余删掉。
     */
    expect(wb).toMatch(/回上传页/);
    // 顶栏按钮 + 素材卡片里的换素材入口
    expect((wb.match(/requestLeave/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("回上传页不能静默清掉分析成果", () => {
    // 有勾选/候选才弹确认；进行中的任务要拦住而不是丢
    expect(wb).toMatch(/setLeaveAskOpen\(true\)/);
    expect(wb).toMatch(/transcribing \|\| detecting/);
    expect(wb).toMatch(/清掉并回上传页/);
    // 确认框里要说明会丢什么、并提示已保存的项目不丢
    expect(wb).toMatch(/留在出片台/);
    expect(wb).toMatch(/最近项目/);
  });
  const types = read("src/shared/api-types.ts");
  const clipper = readFileSync("D:/GLB/Hermes/src/clipper/index.js", "utf8");

  it("ExportRequest 必须能带 projectId", () => {
    // 不带的话包装永远按原始勾选新建工程,用户选的版本被无视,而且不报错
    expect(types).toMatch(/projectId\?: number/);
  });

  it("带了 projectId 必须跳过建工程,直接包装那一版", () => {
    expect(client).toMatch(/if \(request_\.projectId\)/);
    expect(client).toMatch(/wrapExistingProject/);
  });

  it("包装那一版时不得再调 /pipeline/clip", () => {
    // 这就是原来的 bug:重新建工程 -> 出的是另一版片子。
    // 只取 projectId 分支那一段(到"分支 B"标记为止),否则会把正常那条路圈进来。
    const start = client.indexOf("if (request_.projectId)");
    const end = client.indexOf("分支 B");
    const branch = client.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(branch).not.toMatch(/"\/pipeline\/clip"/);
    expect(branch).toMatch(/wrapExistingProject/);
  });

  it("界面必须记住选了哪一版并传给导出", () => {
    expect(wb).toMatch(/pickedVariant/);
    expect(wb).toMatch(/pickedVariant\?\.projectId \? \{ projectId: pickedVariant\.projectId \}/);
  });

  it("面板要标出当前选中的版本,并允许取消", () => {
    expect(panel).toMatch(/pickedVariant\?\.id === v\.id/);
    expect(panel).toMatch(/onClearPick/);
  });

it("编排层必须转发 viralOpening,否则界面上关不掉前置", () => {
    // 以前 clip-variants 的解构里没有 viralOpening,用户关了开关,
    // 每一版照样被前置,而界面只显示"已关闭"
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    const handler = orch.slice(orch.indexOf("'/pipeline/clip-variants'"), orch.indexOf("'/pipeline/set-selection'"));
    expect(handler).toMatch(/viralOpening/);
  });

  it("Clipper 也要看全局开关,不然转发下来也没用", () => {
    // 以前写死 viralOpening: plan.opening !== 'none',把界面开关整个架空。
    // 光在编排层转发不够,这一行必须取交集。
    expect(clipper).toMatch(/viralOpening: opts\.viralOpening !== false && plan\.opening !== 'none'/);
  });

  it("多版本链路必须传 segmentIds,否则每版都报'没有可用分段'", () => {
    // _resolveVariantSegments 没有 segmentIds 就返回空,不做自动选段
    expect(clipper).toMatch(/_resolveVariantSegments\(liveVideoId, opts\)/);
    expect(orchestratorSegIds()).toBe(true);
  });

  function orchestratorSegIds(): boolean {
    const orch = readFileSync("D:/GLB/Hermes/src/orchestrator/index.js", "utf8");
    const handler = orch.slice(orch.indexOf("'/pipeline/clip-variants'"), orch.indexOf("'/pipeline/set-selection'"));
    return /segmentIds/.test(handler);
  }

  it("没有 projectId 的版本不能被选(否则选了个空壳)", () => {
    expect(panel).toMatch(/disabled=\{!done\.projectId\}/);
  });

  it("选了版本时不该再要求勾选非空", () => {
    expect(wb).toMatch(/picked\.length === 0 && !pickedVariant\?\.projectId/);
  });
});

describe("历史项目恢复", () => {
  const main = read("src/main/index.ts");
  const imp = read("src/renderer/src/components/ImportStage.tsx");

  it("首屏必须有最近项目入口(否则历史项目无法访问)", () => {
    // 死锁设计缺陷:项目库入口只在工作台侧栏,
    // 而工作台必须先有素材才渲染 —— 没项目就打不开项目。
    expect(imp).toMatch(/最近项目/);
    expect(imp).toMatch(/reopen/);
  });

  it("索引必须归一化(旧版存 source.path,新版存 sourcePath)", () => {
    // 不归一化的话 sourcePath 是 undefined,界面报"没有记录素材路径"
    expect(main).toMatch(/function normalizeProjectEntry/);
    expect(main).toMatch(/source\?\.path/);
  });

  it("检查点必须兼容三种形态", () => {
    // ① 新版 .json 顶层是检查点
    // ② 旧版 .glb 顶层包一层 { checkpoint }
    // ③ 早期 .glb 顶层直接是检查点
    expect(main).toMatch(/async function readCheckpoint/);
    expect(main).toMatch(/\["\.json", "\.glb"\]/);
    expect(main).toMatch(/raw\.checkpoint/);
  });

  it("旧版检查点缺 name,必须补(否则界面显示 undefined.mp4)", () => {
    expect(main).toMatch(/function normalizeCheckpoint/);
    expect(main).toMatch(/name: typeof file\.name === "string"/);
  });

  it("liveVideoId 缺省为 null,不能是 undefined", () => {
    // undefined 会让出片判断失效且不报错
    expect(main).toMatch(/liveVideoId: null,\s*\n\s*\.\.\.cp/);
  });

  it("打开老项目要给出需要重新分析的提示,而不是假装完整", () => {
    expect(imp).toMatch(/没保存分析结果，需要重新跑一次/);
  });
});

describe("工作区归属", () => {
  it("必须指向历史项目目录,否则侧栏永远是空的", () => {
    const main = read("src/main/index.ts");
    // Electron 默认 userData = %APPDATA%/<packageName>(glb-studio),
    // 历史项目在 %APPDATA%\glb\projects,不改路径就等于用户项目"消失"。
    expect(main).toMatch(/adoptLegacyWorkspace/);
    expect(main).toMatch(/app\.setPath\(\s*["']userData["']/);
  });

  it("setPath 必须在 app ready 之前执行", () => {
    const main = read("src/main/index.ts");
    const adoptAt = main.indexOf("adoptLegacyWorkspace();");
    const readyAt = main.indexOf("app.whenReady()");
    expect(adoptAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(adoptAt).toBeLessThan(readyAt);
  });

  it("旧目录不存在时不得强设路径(避免造出空壳)", () => {
    const main = read("src/main/index.ts");
    const fn = main.slice(main.indexOf("function adoptLegacyWorkspace"), main.indexOf("adoptLegacyWorkspace();"));
    expect(fn).toMatch(/existsSync\(legacy\)/);
  });
});

describe("Hermes 爆点分析契约", () => {
  const client = read("src/main/hermes-client.ts");
  const analyzer = readFileSync(
    "D:/GLB/Hermes/src/analyzer/live-analyzer.js",
    "utf8"
  );

  it("服务端必须返回归一化后的段,而不是 LLM 原始对象", () => {
    // 真实契约: return { liveVideoId, segments: normalized, health }
    // 之前直接返回 allSegments(下划线 start_seconds / theme_name),
    // 客户端按驼峰读全 undefined —— 界面 210 条全是"未命名片段 / 0.0s→0.0s"。
    // 注意零长段已经在写库前从 allSegments 里剔除了，所以这里直接 map 即可，
    // 序号也保持连续。详见"长直播超时与零长段"那组测试。
    expect(analyzer).toMatch(/const normalized = allSegments\.map/);
    expect(analyzer).toMatch(/return \{ liveVideoId, segments: normalized, health \}/);
    // 归一化必须同时覆盖时间与主题
    expect(analyzer).toMatch(/startMs: Math\.round/);
    expect(analyzer).toMatch(/themeName: seg\.theme_name/);
    // 绝不能再返回原始段
    expect(analyzer).not.toMatch(/return \{ liveVideoId, segments: allSegments/);
    // 失败侧:客户端不读不存在的 candidates
    expect(client).not.toMatch(/res\.candidates\s*\?\?/);
    expect(client).toMatch(/res\.segments\s*\?\?\s*\[\]/);
  });

  it("客户端必须兼容两种字段名(驼峰/下划线)", () => {
    // 服务端已归一化,但双格式兼容能防契约再次错位时静默变空
    expect(client).toMatch(/seg\.themeName \|\| seg\.theme_name/);
    expect(client).toMatch(/seg\.hookQuality \?\? seg\.hook_quality/);
    expect(client).toMatch(/Number\(seg\.start_seconds\) \* 1000/);
  });

  it("契约错位时必须显式报错,不能渲染成空候选", () => {
    // 210 条"未命名片段"比报错更糟:用户看不出是程序坏了
    expect(client).toMatch(/既无主题名也无时长/);
    expect(client).toMatch(/usable\.length === 0/);
  });

  it("分数必须统一到 0~100(界面按 100 分制显示与分档)", () => {
    // Hermes 给 0~1,不转的话每条都显示"—",分数分档功能等于没生效
    expect(client).toMatch(/Math\.round\(Math\.max\(0, Math\.min\(1, hook\)\) \* 100\)/);
    expect(client).toMatch(/score: score100/);
  });

  it("客户端按 segmentIndex 建立候选 id(出片选段依赖它)", () => {
    expect(client).toMatch(/seg\.segmentIndex \?\? seg\.segment_index/);
  });

  it("毫秒转秒不得写反", () => {
    expect(client).toMatch(/startSec:\s*startMs\s*\/\s*1000/);
  });

  it("分析级失败要抛错,不能降级成空候选骗用户", () => {
    expect(client).toMatch(/health\?\.grade\s*===\s*["']error["']/);
  });

  it("transcribe 不得把体检端点当转写端点用", () => {
    // scan 只体检:Hermes 的 ASR 跑在 analyze-live 内部,无独立转写端点
    const body = client.slice(client.indexOf("async transcribe"), client.indexOf("async detect"));
    expect(body).toMatch(/\/pipeline\/scan/);
    // 不能再出现把 scan 结果直接当 Transcript 返回的写法
    expect(body).not.toMatch(/this\.call<Transcript>\("POST",\s*"\/pipeline\/scan"/);
  });
});
