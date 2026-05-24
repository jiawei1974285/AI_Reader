/**
 * 简化 fzf 风格的模糊匹配。
 *
 * 评价标准 (CLAUDE.md 原则 1 实践检验):
 *   - 用户输入 "人间" 应能命中 "人间词话"
 *   - "三体" 命中 "刘慈欣 - 三体"
 *   - "music" 命中 "Music view"（大小写不敏感）
 *   - "xyz" 在 "abcdef" 上 → 不匹配
 *
 * 算法:
 *   1. q / target 都 toLowerCase，但中文保持
 *   2. q 的每个字符按顺序在 target 里找下一个位置（子序列匹配）
 *   3. 不匹配（任一字符找不到）→ 返回 null
 *   4. 匹配则按下面规则打分：
 *      - 基础 1 分
 *      - 命中位置在 target 起始 / 紧跟空格或 "-" / "_" / "/" → +3 (词首加分)
 *      - 与上一个命中相邻 → +5 (连续片段加分)
 *      - 间隔越大扣分越多 (-gap)
 *   5. 短 target 更优先（避免 100 行长文本压过 5 字标题）
 */

export type MatchResult = {
  /** 越大越好。null 表示不匹配。 */
  score: number;
  /** 命中字符在 target 的索引数组，可用于高亮。 */
  indices: number[];
};

const BOUNDARY = new Set([" ", "-", "_", "/", "·", "—", "/"]);

export function fuzzyMatch(target: string, q: string): MatchResult | null {
  if (q === "") return { score: 0, indices: [] };
  const t = target.toLowerCase();
  const query = q.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  let prevHit = -2;
  let score = 0;

  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    // 跳过查询里的空白
    if (ch === " " || ch === "\t") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    indices.push(found);

    // 打分
    score += 1;
    const prevCh = found > 0 ? t[found - 1] : "";
    if (found === 0 || BOUNDARY.has(prevCh)) score += 3;
    if (found === prevHit + 1) score += 5;
    else if (prevHit >= 0) score -= Math.min(3, found - prevHit - 1);
    prevHit = found;
  }
  // 短 target 优先
  score += Math.max(0, 30 - t.length) * 0.1;
  return { score, indices };
}
