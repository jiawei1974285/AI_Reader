import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ipc, type Book, type BookmarkWithBook } from "@/lib/ipc";
import { fuzzyMatch, type MatchResult } from "./commandMatch";

/**
 * C6 — 全局命令面板 (Ctrl/Cmd+K)
 *
 * 评审 C6: 书库 50+ 本时手点导航低效。
 * 设计 (CLAUDE.md 原则 17 协调信号): 单一面板提供"看到所有可达动作"
 * 的统一界面 —— 打开书、切换视图、跳书签、reader 内调主题/字号/全屏。
 * 不依赖任何已有大组件 (零冲突)，纯新增。
 *
 * 入口由 useCommandPalette 提供 (本目录另一文件)。这个组件只负责渲染 +
 * 上下键导航 + Enter 执行 + ESC 关闭。
 */

export type CommandAction = {
  /** 稳定 id，用于 React key。 */
  id: string;
  /** 显示主标题 (会被模糊匹配)。 */
  label: string;
  /** 副标题/说明 (灰色)，可选。也会被匹配。 */
  hint?: string;
  /** 命令分组 (顶部 chip 显示)。 */
  group: "导航" | "书" | "书签" | "Reader" | "主题" | "其他";
  /** 执行。同步或异步都可。返回 false 表示不要关闭面板（罕见）。 */
  run: () => void | Promise<void | false>;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Reader 视图独有的命令（主题切换 / 字号 / 全屏 / 跳章 etc）。可选。 */
  extraActions?: CommandAction[];
  /** 切到 library / notes / music / stats / ai 设置 — 由 App 注入。 */
  navigate: {
    library: () => void;
    notes: () => void;
    music: () => void;
    stats: () => void;
    openAiSettings: () => void;
  };
  /** 打开一本书 — 由 App 注入。 */
  openBook: (book: Book, spineIndex?: number, scrollY?: number) => void;
};

export function CommandPalette({
  open,
  onClose,
  extraActions = [],
  navigate,
  openBook,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [books, setBooks] = useState<Book[]>([]);
  const [recentBookmarks, setRecentBookmarks] = useState<BookmarkWithBook[]>(
    [],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时拉一次书 + 最近书签（cheap，全本地 SQLite）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIdx(0);
    Promise.all([ipc.listBooks(), ipc.listRecentBookmarks(20)])
      .then(([bs, bms]) => {
        setBooks(bs);
        setRecentBookmarks(bms);
      })
      .catch(() => {});
  }, [open]);

  // 自动 focus 输入框
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 构造命令池
  const allActions: CommandAction[] = useMemo(() => {
    const nav: CommandAction[] = [
      {
        id: "nav-library",
        label: "切换到书架",
        hint: "Library",
        group: "导航",
        run: navigate.library,
      },
      {
        id: "nav-notes",
        label: "打开笔记",
        hint: "全局批注 / 高亮检索",
        group: "导航",
        run: navigate.notes,
      },
      {
        id: "nav-music",
        label: "打开音乐",
        hint: "背景音乐 / NCM 解密",
        group: "导航",
        run: navigate.music,
      },
      {
        id: "nav-stats",
        label: "打开阅读统计",
        hint: "时长 / 日历 / 分类分布",
        group: "导航",
        run: navigate.stats,
      },
      {
        id: "nav-ai-settings",
        label: "打开 AI 设置",
        hint: "base_url / api_key / model",
        group: "导航",
        run: navigate.openAiSettings,
      },
    ];
    const bookActions: CommandAction[] = books.map((b) => ({
      id: `book-${b.id}`,
      label: b.title || "(无题)",
      hint: b.author || "—",
      group: "书",
      run: () => openBook(b),
    }));
    const bmActions: CommandAction[] = recentBookmarks.map((bm) => ({
      id: `bm-${bm.id}`,
      label: bm.label || "未命名书签",
      hint: `${bm.book_title} · 第 ${bm.spine_index + 1} 章`,
      group: "书签",
      run: () => {
        // 找到对应书然后 openBook 带 initial spine + scroll
        const book = books.find((b) => b.id === bm.book_id);
        if (book) openBook(book, bm.spine_index, bm.scroll_y);
      },
    }));
    return [...nav, ...extraActions, ...bmActions, ...bookActions];
  }, [books, recentBookmarks, extraActions, navigate, openBook]);

  // 排序：每个命令按 fuzzy 分数排，无匹配的丢掉。空 query 时按原顺序。
  const filtered: Array<{ action: CommandAction; match: MatchResult }> =
    useMemo(() => {
      if (query.trim() === "") {
        return allActions.map((a) => ({
          action: a,
          match: { score: 0, indices: [] },
        }));
      }
      const out: Array<{ action: CommandAction; match: MatchResult }> = [];
      for (const action of allActions) {
        const labelMatch = fuzzyMatch(action.label, query);
        const hintMatch = action.hint ? fuzzyMatch(action.hint, query) : null;
        // 取分数高的那个（label 优先：相同分数下 label 占优）
        let best: MatchResult | null = null;
        if (labelMatch) best = labelMatch;
        if (hintMatch && (!best || hintMatch.score > best.score + 1)) {
          best = hintMatch;
        }
        if (!best) continue;
        out.push({ action, match: best });
      }
      out.sort((a, b) => b.match.score - a.match.score);
      // 上限避免渲染列表过长
      return out.slice(0, 80);
    }, [allActions, query]);

  // selection clamp
  useEffect(() => {
    if (selectedIdx >= filtered.length && filtered.length > 0) {
      setSelectedIdx(filtered.length - 1);
    }
  }, [filtered.length, selectedIdx]);

  // 选中项滚到可见
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(
      `[data-cmd-idx="${selectedIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const exec = useCallback(
    async (action: CommandAction) => {
      try {
        const result = await action.run();
        if (result !== false) onClose();
      } catch {
        onClose();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      <div
        className="relative w-[min(640px,92vw)] studio-panel shadow-2xl flex flex-col overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const item = filtered[selectedIdx];
            if (item) exec(item.action);
          }
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
          placeholder="输入命令、书名、书签..."
          className="w-full px-5 py-4 bg-transparent text-base text-[var(--color-ink)] outline-none border-b border-[var(--color-paper-edge)]"
        />

        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto"
          style={{ scrollbarWidth: "thin" }}
        >
          {filtered.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs studio-subtle">
              没有匹配的命令。
            </div>
          ) : (
            filtered.map((item, idx) => (
              <CommandRow
                key={item.action.id}
                idx={idx}
                selected={idx === selectedIdx}
                action={item.action}
                indices={item.match.indices}
                onClick={() => exec(item.action)}
                onHover={() => setSelectedIdx(idx)}
              />
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--color-paper-edge)] flex items-center justify-between text-[10px] studio-subtle">
          <span>↑↓ 选择 · Enter 执行 · Esc 退出</span>
          <span className="tabular-nums">{filtered.length} 项</span>
        </div>
      </div>
    </div>
  );
}

function CommandRow({
  idx,
  selected,
  action,
  indices,
  onClick,
  onHover,
}: {
  idx: number;
  selected: boolean;
  action: CommandAction;
  indices: number[];
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <div
      data-cmd-idx={idx}
      onMouseMove={onHover}
      onClick={onClick}
      className={[
        "px-5 py-2.5 flex items-center gap-3 cursor-pointer text-sm",
        selected
          ? "bg-[var(--color-accent)]/15 text-[var(--color-ink)]"
          : "text-[var(--color-ink)] hover:bg-[var(--color-paper-edge)]/30",
      ].join(" ")}
    >
      <GroupChip group={action.group} />
      <div className="flex-1 min-w-0">
        <div className="truncate">{highlight(action.label, indices)}</div>
        {action.hint ? (
          <div className="text-[11px] studio-subtle truncate mt-0.5">
            {action.hint}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GroupChip({ group }: { group: CommandAction["group"] }) {
  const color: Record<CommandAction["group"], string> = {
    导航: "bg-blue-500/15 text-blue-600",
    书: "bg-amber-500/15 text-amber-700",
    书签: "bg-fuchsia-500/15 text-fuchsia-700",
    Reader: "bg-emerald-500/15 text-emerald-700",
    主题: "bg-slate-500/15 text-slate-600",
    其他: "bg-neutral-400/15 text-neutral-600",
  };
  return (
    <span
      className={`flex-shrink-0 text-[10px] tracking-wider px-1.5 py-0.5 rounded ${color[group]}`}
    >
      {group}
    </span>
  );
}

function highlight(text: string, indices: number[]): ReactNode {
  if (!indices.length) return text;
  const set = new Set(indices);
  const out: ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      out.push(
        <mark
          key={i}
          className="bg-[var(--color-accent)]/30 text-[var(--color-ink)] rounded-sm"
        >
          {text[i]}
        </mark>,
      );
    } else {
      out.push(text[i]);
    }
  }
  return out;
}
