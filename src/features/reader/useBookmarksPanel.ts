import { useCallback, useEffect, useState } from "react";
import { ipc, type Bookmark } from "@/lib/ipc";

/**
 * B2 - 抽出阅读器右侧书签抽屉的状态：
 *
 *   - bookmarksOpen / setBookmarksOpen  — 抽屉开关
 *   - bookmarks / bookmarksLoading       — 列表数据
 *   - refresh                            — 抽屉打开时自动拉，外部也可手动调
 *
 * 行为：抽屉关时不主动刷新（书签不会高频变；首次打开拉一次足够）。
 * 抽屉再次打开时 effect 会重跑 refresh，所以删/加书签后关再开能看到新值。
 */
export function useBookmarksPanel(bookId: number): {
  bookmarks: Bookmark[];
  bookmarksOpen: boolean;
  setBookmarksOpen: React.Dispatch<React.SetStateAction<boolean>>;
  bookmarksLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);

  const refresh = useCallback(async () => {
    setBookmarksLoading(true);
    try {
      setBookmarks(await ipc.listBookmarksByBook(bookId));
    } catch {
      setBookmarks([]);
    } finally {
      setBookmarksLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (bookmarksOpen) refresh();
  }, [bookmarksOpen, refresh]);

  return {
    bookmarks,
    bookmarksOpen,
    setBookmarksOpen,
    bookmarksLoading,
    refresh,
  };
}
