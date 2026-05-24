/**
 * B2 — 把 EpubView 里"读到哪/恢复到哪/保存到哪"这一族逻辑收成一个 hook。
 *
 * 之前散在 EpubView 三个 useEffect 里：
 *   1. mount 时从 DB 取 progress + initialSpine 决定首章
 *   2. chapters 渲染好后用段落锚（A4）或 scroll_y（A4 fallback）恢复
 *   3. 滚动 throttle 后写 paragraph_index + scroll_y 到 DB
 *
 * 三件事其实是**同一个反馈环**（CLAUDE.md 原则 9）：observe → bank → restore。
 * 散在三处时，A4 加段落锚改了 3 个地方，未来加阅读速度 / 完读率（C2）
 * 还要再改 3 处。抽 hook 后只改一个文件。
 *
 * 这个 hook **不直接做 DOM scroll/listen**——保留主组件持有 scrollRef 的所有权，
 * hook 只负责 (a) 决定初始恢复目标 (b) 提供 `recordScrollPosition` 一个 onScroll
 * 里可调用的写入函数。这样和 EpubView 现有的 onScroll throttle 实现不互相打架。
 */

import { useEffect, useRef, useState } from "react";
import { ipc, type EpubPreview } from "@/lib/ipc";

export type RestoreTarget = {
  /** A4 段落锚（优先） */
  anchor: { paragraphIndex: number; charOffset: number } | null;
  /** A4 fallback：绝对像素 scroll_y（或分页模式下的 scroll_x） */
  scrollY: number;
};

type LoadInitialChapterParams = {
  path: string;
  bookId: number;
  /** 调用方明确指定首章（从 NotesView 跳过来时用），优先级最高。 */
  initialSpine?: number;
  /** 配合 initialSpine 用的滚动位置。 */
  initialScrollY?: number;
};

type UseReadingProgressResult = {
  /** 启动时已经决定好的恢复目标。在 chapters 渲染完 + settingsReady 后用它做 scroll。 */
  restoreTarget: RestoreTarget;
  /** 由调用方在 chapter 初次加载完成后调用一次，注入 setChapters/setActiveIdx。 */
  loadInitialChapter: (
    params: LoadInitialChapterParams,
  ) => Promise<EpubPreview>;
  /**
   * 在 onScroll 节流回调里调用，写入「当前 spine + 段落锚 + scroll 像素」到 DB。
   * 失败不抛（DB 满 / 锁等待）——这是后台心跳类操作，不能影响阅读。
   */
  recordScrollPosition: (params: {
    bookId: number;
    spineIndex: number;
    scrollPixel: number;
    paragraphIndex: number | null;
    charOffset: number | null;
  }) => void;
  /** 清掉一次性的 restoreTarget（消费后调）。 */
  consumeRestoreTarget: () => void;
};

export function useReadingProgress(): UseReadingProgressResult {
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget>({
    anchor: null,
    scrollY: 0,
  });
  const consumed = useRef(false);

  const loadInitialChapter = async ({
    path,
    bookId,
    initialSpine,
    initialScrollY,
  }: LoadInitialChapterParams): Promise<EpubPreview> => {
    consumed.current = false;
    if (initialSpine !== undefined) {
      // 调用方指定 → 用调用方的 scroll_y，不查 DB anchor
      setRestoreTarget({ anchor: null, scrollY: initialScrollY ?? 0 });
      return await ipc.readBookChapter(path, initialSpine);
    }
    const progress = await ipc.getProgress(bookId);
    const initial = progress
      ? await ipc.readBookChapter(path, progress.spine_index)
      : await ipc.readBookInitial(path);
    setRestoreTarget({
      anchor:
        progress?.paragraph_index != null
          ? {
              paragraphIndex: progress.paragraph_index,
              charOffset: progress.char_offset ?? 0,
            }
          : null,
      scrollY: progress?.scroll_y ?? 0,
    });
    if (!progress) {
      // 第一次打开 → 立刻在 DB 落一个章首
      ipc.saveProgress(bookId, initial.spine_index, 0, 0, 0).catch(() => {});
    }
    return initial;
  };

  const recordScrollPosition: UseReadingProgressResult["recordScrollPosition"] =
    ({ bookId, spineIndex, scrollPixel, paragraphIndex, charOffset }) => {
      ipc
        .saveProgress(bookId, spineIndex, scrollPixel, paragraphIndex, charOffset)
        .catch(() => {});
    };

  const consumeRestoreTarget = () => {
    if (consumed.current) return;
    consumed.current = true;
    setRestoreTarget({ anchor: null, scrollY: 0 });
  };

  // 兼容：path/bookId 切换时由 EpubView 主动调 loadInitialChapter，
  // 这里只把 consumed flag 重置就够，restoreTarget 由调用方在 loadInitial 后重写。
  useEffect(() => {
    consumed.current = false;
  }, []);

  return {
    restoreTarget,
    loadInitialChapter,
    recordScrollPosition,
    consumeRestoreTarget,
  };
}
