import { useEffect, useState, type RefObject } from "react";
import { captureSelection } from "./highlight";
import type { Highlight } from "@/lib/ipc";

export type PendingSelection = {
  rect: DOMRect;
  rects: DOMRect[];
  spineIdx: number;
  selectedText: string;
  prefix: string;
  suffix: string;
};

export type ActiveHighlight = {
  hl: Highlight;
  rect: DOMRect;
};

type Params = {
  /** EPUB / TXT / DOCX reader 的滚动容器。`<mark.ai-hl>` 的点击监听挂这里。 */
  scrollRef: RefObject<HTMLElement | null>;
  /** 浮动工具栏的根 element。mousedown 落在它内部时不收 popover。 */
  toolbarRef: RefObject<HTMLElement | null>;
  /** 当前书所有高亮的扁平列表。点击 mark 时按 id 反查这个列表。 */
  allHighlights: Highlight[];
};

/**
 * B2 - 把 EpubView 里「选区浮动工具栏 + 点击高亮 popover」三个 effect
 * 抽出来：mouseup 捕获选区 → 工具栏；mousedown 外点 dismiss；点击 mark
 * 打开 popover。
 *
 * 之前散在 EpubView 中部 50+ 行 / 3 个 effect / 6 个 setState 调用，
 * 修「选区为空 / 选区跨章 / NBSP 容错」时容易撞坏其他逻辑。抽出后
 * 这 3 个事件源 + 2 个 state 在一个文件里能一次看完。
 *
 * 行为细节（沿用之前实现，保持兼容）：
 *   - mouseup 后 setTimeout(10) 等浏览器把 Selection 真正稳定下来再读
 *   - 选区必须落在带 `data-spine` 的 section 内才记为有效（避免书外文字也弹 popover）
 *   - 点击工具栏自身 / mark 时不收 popover（否则点工具栏按钮自己就把自己关了）
 */
export function useSelectionPopover({
  scrollRef,
  toolbarRef,
  allHighlights,
}: Params): {
  pendingSel: PendingSelection | null;
  setPendingSel: React.Dispatch<React.SetStateAction<PendingSelection | null>>;
  activeHl: ActiveHighlight | null;
  setActiveHl: React.Dispatch<React.SetStateAction<ActiveHighlight | null>>;
} {
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null);
  const [activeHl, setActiveHl] = useState<ActiveHighlight | null>(null);

  // 1. mouseup → 捕获选区到 pendingSel
  useEffect(() => {
    function onMouseUp() {
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          setPendingSel(null);
          return;
        }
        const range = sel.getRangeAt(0);
        let node: Node | null = range.commonAncestorContainer;
        let section: HTMLElement | null = null;
        while (node) {
          if (node instanceof HTMLElement && node.dataset.spine != null) {
            section = node;
            break;
          }
          node = node.parentNode;
        }
        if (!section) {
          setPendingSel(null);
          return;
        }
        const cap = captureSelection(section);
        if (!cap) {
          setPendingSel(null);
          return;
        }
        setPendingSel({
          rect: cap.rect,
          rects: cap.rects,
          spineIdx: Number(section.dataset.spine),
          selectedText: cap.selectedText,
          prefix: cap.prefix,
          suffix: cap.suffix,
        });
      }, 10);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // 2. mousedown 外部 → dismiss
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = eventElement(e.target);
      if (!target) return;
      if (toolbarRef.current && toolbarRef.current.contains(target)) return;
      if (target.closest("mark.ai-hl")) return;
      setPendingSel(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [toolbarRef]);

  // 3. 点击 <mark.ai-hl> → 打开 popover
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    function onClick(e: Event) {
      const target = eventElement(e.target);
      if (!target) return;
      const mark = target.closest("mark.ai-hl") as HTMLElement | null;
      if (!mark) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(mark.dataset.hlId);
      const hl = allHighlights.find((h) => h.id === id);
      if (!hl) return;
      setActiveHl({ hl, rect: mark.getBoundingClientRect() });
    }
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [allHighlights, scrollRef]);

  return { pendingSel, setPendingSel, activeHl, setActiveHl };
}

function eventElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}
