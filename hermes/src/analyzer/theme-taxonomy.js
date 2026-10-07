/**
 * 受控主题词表 —— 加载与归一。
 *
 * 为什么不让模型自由命名主题：实测 16 条爆款素材产出 47 个主题，
 * 全是同义变体 ——
 *   「高音技巧教学」/「高音定位训练」/「高音位置衔接」其实是一类
 *   「科学发声技巧」/「声乐技巧教学」/「歌唱技巧讲解」也是一类
 * 样本最多的主题只有 3 个，没有一个到门槛，面板显示成一堆几乎不重复的词，
 * 匹配时也因为叫法不同而命不中。
 *
 * 词表本身放 data/theme-taxonomy.json（可编辑，加品类不用改代码）。
 *
 * 为什么单独成模块（而不是留在 hit-analyzer.js 里）：
 * 历史数据归一脚本要复用同一份实现。两处各写一遍归一逻辑，
 * 过几个月一定会漂 —— 迁移脚本按旧规则跑，运行时按新规则判，同一个主题名
 * 在两处得到不同分类，而且没人会发现。所以这里导出唯一的实现，
 * 分析器和 scripts/normalize-hit-themes.mjs 都从这里取。
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 词表文件路径 */
export const TAXONOMY_PATH = join(__dirname, '..', '..', 'data', 'theme-taxonomy.json');

/**
 * 读词表。文件不在、JSON 坏了、categories 不是非空数组 —— 全部返回 null，
 * 调用方退回自由命名。宁可主题碎，也不能让分析整个失败。
 *
 * @param {string} [path] 覆盖词表路径（测试用坏路径来验证降级）
 */
export function loadThemeTaxonomy(path = TAXONOMY_PATH) {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(j.categories) || j.categories.length === 0) return null;
    return j.categories;
  } catch (err) {
    console.warn(`[主题词表] 读取失败，退回自由命名: ${err.message}`);
    return null;
  }
}

/**
 * 把主题名收敛到受控分类。
 *
 * 提示词里已经要求"只能从词表里选"，但模型不一定听话（本地 8B 尤其不稳）。
 * 所以写库前再兜一层：拿分类的召回词去匹配模型给的主题名和 keywords，
 * 命中就换成标准分类名。这样即便模型自由命名，落库的也是可聚合的。
 *
 * 匹配不上就原样保留 —— 宁可多一个野生主题，也不要把内容归错类。
 * 归错类比不归更坏：它会污染这个分类下的所有样本，而且无法从库里看出来。
 *
 * ── 为什么不能「命中一个关键词就算一分」──
 * 词表里同时有两种词：
 *   专有说法：「发音位置」「口腔搭建」「声音聚焦」—— 指一件事
 *   泛    词：「声音」「发力」「气息」      —— 几乎每条都沾
 * 等权计分时，一条叫「发音位置的重要性」的主题，keywords 是
 * [发音位置, 气息, 声音, 发力]，「发音位置」和「气息」各得 1 分，
 * 分数打平，最后按词表顺序取第一个 —— 结果「发音位置的重要性」
 * 被归进了「气息与腹式呼吸」。这不是匹配，是掷骰子。
 *
 * 真正要分档的是**证据从哪来**，而不是词长什么样：
 * 模型自己列进 keywords 的，是它认为这条素材的特征，权重最高；
 * 主题名里顺带撞上的最弱 —— 因为主题名大多是「唱歌技巧教学」这种泛标签，
 * 两字泛词（纠正/方法/练习/问题）在里面几乎必然出现。
 * 按来源分档就不用去猜「哪些词算泛词」，也不用给 `高音` 这种
 * 货真价实的两字术语打折扣。
 *
 * 四档权重（w = 关键词字数，上限 6）：
 *   模型明确列为 keyword      w × 2   「压喉」「鼻孔发力」被点名
 *   关键词包含该词            w × 0.5 「共鸣墙体」里含「共鸣」
 *   出现在主题名里            w × 1   「高音技巧教学」含「高音」
 *   分类名与主题名互含        + 4
 *
 * 另加一条：最优比次优领先不足 1.5 分就放弃。
 * 「唱歌技巧教学」[吸气/腔体] 的气息和共鸣各 4 分打平 —— 这条素材
 * 真的两可，赌一个错分类会污染那一整类样本，比留个野生主题坏得多。
 */

/** 关键词权重 = 字数，上限 6。「发音位置」(4) 权重 4，「声音」(2) 权重 2 */
const specificity = (kw) => Math.min(kw.length, 6);

/** 证据分档 */
const W_KW_EXACT = 2;        // 模型明确列为 keyword
const W_KW_CONTAINS = 0.5;   // 用户 keyword 里包含该词
const W_NAME_SUBSTRING = 1;  // 出现在主题名里
const W_CATEGORY_NAME = 4;   // 分类名与主题名互含

/** 最优比次优至少要领先这么多，否则算「分不清」，不归一 */
const MIN_MARGIN = 1.5;

/**
 * 给每个分类打分，并说明每一分是怎么来的。
 *
 * 归一是黑盒，出错时没法复核：「发音方法纠正」被判给哪个分类、
 * 压过了什么、领先多少，光看结果全看不见。迁移历史数据时这点很要紧 ——
 * 47 个主题名逐条看下来才知道有没有归错。
 *
 * 单独导出、而不是在归一函数里打日志，是为了让诊断脚本复用同一份实现。
 * 早先诊断脚本里照抄了一份权重，几周后改了这边的权重，脚本还在按老规则解释，
 * 排查时反而会被它带偏。
 *
 * @returns {{category: string, score: number, reasons: string[]}[]} 按分数降序
 */
export function scoreCategories(themeName, keywords) {
  const cats = loadThemeTaxonomy();
  if (!cats) return [];
  const name = themeName || '';
  const kws = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const out = [];

  for (const c of cats) {
    if (c.name === name) {
      return [{ category: c.name, score: Infinity, reasons: ['已经是标准分类名'] }];
    }
    let score = 0;
    const reasons = [];
    for (const kw of c.keywords || []) {
      if (!kw) continue;
      const w = specificity(kw);
      if (name.includes(kw)) {
        const v = w * W_NAME_SUBSTRING;
        score += v;
        reasons.push(`主题名含「${kw}」+${v}`);
      }
      for (const u of kws) {
        if (u === kw) {
          const v = w * W_KW_EXACT;
          score += v;
          reasons.push(`关键词「${kw}」+${v}`);
        } else if (u.includes(kw)) {
          const v = w * W_KW_CONTAINS;
          score += v;
          reasons.push(`关键词含「${kw}」+${v}`);
        }
      }
    }
    // 分类名本身出现在主题名里（如「共鸣与腔体」之于「共鸣腔体的使用」）
    if (name && (name.includes(c.name) || c.name.includes(name))) {
      score += W_CATEGORY_NAME;
      reasons.push(`分类名互含 +${W_CATEGORY_NAME}`);
    }
    if (score > 0) out.push({ category: c.name, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * 把主题名收敛到受控分类。
 *
 * 提示词里已经要求"只能从词表里选"，但模型不一定听话（本地 8B 尤其不稳）。
 * 所以写库前再兜一层：拿分类的召回词去匹配模型给的主题名和 keywords，
 * 命中就换成标准分类名。这样即便模型自由命名，落库的也是可聚合的。
 *
 * 匹配不上就原样保留 —— 宁可多一个野生主题，也不要把内容归错类。
 * 归错类比不归更坏：它会污染这个分类下的所有样本，而且无法从库里看出来。
 *
 * @param {string} themeName 模型给的主题名
 * @param {string[]} keywords 模型给的召回词
 * @returns {string} 标准分类名，或原样返回 themeName
 */
export function normalizeThemeName(themeName, keywords) {
  const scored = scoreCategories(themeName, keywords);
  if (scored.length === 0) return themeName;                       // 一点证据都没有
  if (scored[0].score === Infinity) return scored[0].category;   // 已是标准名
  const second = scored.length > 1 ? scored[1].score : 0;
  if (scored[0].score - second < MIN_MARGIN) return themeName;   // 咬太紧，分不清
  return scored[0].category;
}

/** 归一判定说明：给人看的，输出判给谁、领先多少、每分怎么来的 */
export function explainThemeMatch(themeName, keywords) {
  const scored = scoreCategories(themeName, keywords);
  if (scored.length === 0) return { hit: themeName, margin: Infinity, scored };
  const margin = scored.length > 1 ? scored[0].score - scored[1].score : Infinity;
  const hit = margin >= MIN_MARGIN ? scored[0].category : themeName;
  return { hit, margin, scored };
}

/** 把词表渲染进提示词；没有词表时返回空串 */
export function themeTaxonomyHint() {
  const cats = loadThemeTaxonomy();
  if (!cats) return '';
  const lines = cats.map(
    (c) => `  "${c.name}" — ${c.hint}\n     召回词: ${c.keywords.join('、')}`
  );
  return `
THEME TAXONOMY (必须遵守):
- themes 里的 theme_name **只能**从下面这 ${cats.length} 个分类里选，**不要自己另起名字**。
  自由命名会让同一件事出现十几种叫法，样本永远聚不起来，也匹配不上。
- 每条素材选 2-3 个最能代表内容的分类；都不合适就返回空数组，
  不要为了凑数硬塞一个不准的（错的主题比没主题更有害）。
- keywords 从该分类的召回词里挑，也可以补原文里真实出现的说法。

${lines.join('\n')}
`;
}