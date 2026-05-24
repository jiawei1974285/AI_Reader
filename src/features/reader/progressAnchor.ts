/**
 * A4 — 段落级进度锚定。
 *
 * 之前 reading_progress 只存 `scroll_y` 绝对像素。字号 / 字体 / 列宽 / 主题
 * 一改，同一个 scroll_y 含义完全不同 —— 用户改完设置回到书里发现自己
 * 跳前/后一章。这是 CLAUDE.md 原则 8 的「能控制」漏洞（能看到位置但不能
 * 精确恢复），也是原则 13 的脆弱点（小扰动 → 大偏移）。
 *
 * 新方案：把"上次读到的位置"用 `paragraph_index`（章节内第几个 block-level
 * 子节点）来表达。block-level 数量不随字号变。`scroll_y` 仍然双写，作为：
 *   1. 老数据 fallback；
 *   2. 段落定位失败时的 fallback；
 *   3. 同一段内更精细的回滚（未来可加 char_offset，目前段级足够）。
 */

/**
 * 找出视口顶部"第一个底边已落进可视区"的 block-level 子段落，返回它在
 * chapterEl 直接子节点里的索引。找不到（章节为空 / 全部在视口上方）返 null。
 */
export function findViewportTopAnchor(
  chapterEl: HTMLElement,
  scrollContainer: HTMLElement,
  isPagedMode: boolean,
): { paragraphIndex: number; charOffset: number } | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  // 给个 80px 让 toolbar / 上一段 trailing space 都不抢
  const probeY = containerRect.top + 80;
  const probeX = containerRect.left + 80;
  const children = chapterEl.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as HTMLElement;
    const r = child.getBoundingClientRect();
    if (isPagedMode) {
      // 分页：找第一个右边缘还在 probe 之后的段落
      if (r.right >= probeX) {
        return { paragraphIndex: i, charOffset: 0 };
      }
    } else {
      // 滚动：找第一个底边在 probe 线之下的段落
      if (r.bottom >= probeY) {
        return { paragraphIndex: i, charOffset: 0 };
      }
    }
  }
  return null;
}

/**
 * 反向：把视口滚到指定段落的顶部。失败（段落不存在）返 false，调用方
 * 该退回 scroll_y fallback。
 */
export function scrollToAnchor(
  chapterEl: HTMLElement,
  scrollContainer: HTMLElement,
  paragraphIndex: number,
  _charOffset: number,
  isPagedMode: boolean,
): boolean {
  const child = chapterEl.children[paragraphIndex] as HTMLElement | undefined;
  if (!child) return false;
  const containerRect = scrollContainer.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  if (isPagedMode) {
    const offset =
      childRect.left - containerRect.left + scrollContainer.scrollLeft - 40;
    scrollContainer.scrollTo({ left: Math.max(0, offset), top: 0 });
  } else {
    const offset =
      childRect.top - containerRect.top + scrollContainer.scrollTop - 60;
    scrollContainer.scrollTo({ top: Math.max(0, offset), left: 0 });
  }
  return true;
}
