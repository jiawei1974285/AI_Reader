import { useEffect, useMemo, useState, type RefObject } from "react";
import { ipc, type EpubPreview } from "@/lib/ipc";
import { normalizeEntities, type EntityWithKey } from "./entityUnderlines";

type Params = {
  scrollRef: RefObject<HTMLElement | null>;
  aiConfigured: boolean;
  currentChapter: EpubPreview | undefined;
  currentChapterLabel: string;
  /** EpubView 内 htmlToText 实现——交给调用方传，避免 hook 反过来依赖 reader util。*/
  htmlToText: (html: string) => string;
};

type EntitiesBySpine = Record<number, EntityWithKey[]>;

/**
 * B2 - 「本章实体抽取」相关的状态 + 副作用整体抽出。原来在 EpubView 散在：
 *   - 5 个 useState (open / bySpine / loading / error / activeKey)
 *   - 1 个 effect (click on .ai-entity 打开面板)
 *   - 1 个 async fn fetchForCurrentChapter
 *
 * Hook 不渲染 UI——只管状态 + ipc 调用 + DOM click 监听。
 * UI 仍由 EpubView 渲染 ChapterEntitiesPanel；hook 把所有需要的字段
 * 一次性返回。
 */
export function useChapterEntities({
  scrollRef,
  aiConfigured,
  currentChapter,
  currentChapterLabel,
  htmlToText,
}: Params): {
  entitiesBySpine: EntitiesBySpine;
  currentEntities: EntityWithKey[];
  entitiesOpen: boolean;
  setEntitiesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  entitiesLoading: boolean;
  entitiesError: string | null;
  activeEntityKey: string | null;
  setActiveEntityKey: React.Dispatch<React.SetStateAction<string | null>>;
  fetchEntitiesForCurrentChapter: () => Promise<void>;
} {
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const [entitiesBySpine, setEntitiesBySpine] = useState<EntitiesBySpine>({});
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [entitiesError, setEntitiesError] = useState<string | null>(null);
  const [activeEntityKey, setActiveEntityKey] = useState<string | null>(null);

  const currentSpine = currentChapter?.spine_index ?? -1;
  const currentEntities = useMemo(
    () => (currentSpine >= 0 ? entitiesBySpine[currentSpine] ?? [] : []),
    [entitiesBySpine, currentSpine],
  );

  // 点击章节内的 .ai-entity 下划线 → 打开面板并高亮对应实体
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    function onClick(e: Event) {
      const target = eventElement(e.target);
      if (!target) return;
      if (target.closest("mark.ai-hl")) return;
      const span = target.closest(".ai-entity") as HTMLElement | null;
      if (!span) return;
      e.preventDefault();
      e.stopPropagation();
      const key = span.dataset.entityKey;
      if (!key) return;
      const entity = Object.values(entitiesBySpine)
        .flat()
        .find((item) => item.key === key);
      if (!entity) return;
      setEntitiesOpen(true);
      setActiveEntityKey(entity.key);
    }
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [entitiesBySpine, scrollRef]);

  async function fetchEntitiesForCurrentChapter(): Promise<void> {
    if (!currentChapter) return;
    if (!aiConfigured) {
      setEntitiesError("请先在 AI 设置中配置模型接口。");
      return;
    }
    setEntitiesOpen(true);
    setEntitiesLoading(true);
    setEntitiesError(null);
    setActiveEntityKey(null);
    try {
      const result = await ipc.aiExtractEntities({
        chapterLabel: currentChapterLabel,
        chapterText: htmlToText(currentChapter.html),
      });
      const withKeys = normalizeEntities(result);
      setEntitiesBySpine((prev) => ({
        ...prev,
        [currentChapter.spine_index]: withKeys,
      }));
      if (withKeys.length === 0) {
        setEntitiesError("本章没有提取到明显的人名或地名。");
      }
    } catch (e) {
      setEntitiesError(String(e));
    } finally {
      setEntitiesLoading(false);
    }
  }

  return {
    entitiesBySpine,
    currentEntities,
    entitiesOpen,
    setEntitiesOpen,
    entitiesLoading,
    entitiesError,
    activeEntityKey,
    setActiveEntityKey,
    fetchEntitiesForCurrentChapter,
  };
}

function eventElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}
