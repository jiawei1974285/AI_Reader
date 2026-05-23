import type { EntityWithKey } from "./entityUnderlines";

type Props = {
  chapterLabel: string;
  aiConfigured: boolean;
  entities: EntityWithKey[];
  loading: boolean;
  error: string | null;
  activeKey: string | null;
  onExtract: () => void;
  onSelect: (entity: EntityWithKey) => void;
  onOpenSettings: () => void;
  onClose: () => void;
};

export function ChapterEntitiesPanel({
  chapterLabel,
  aiConfigured,
  entities,
  loading,
  error,
  activeKey,
  onExtract,
  onSelect,
  onOpenSettings,
  onClose,
}: Props) {
  const people = entities.filter((e) => e.kind === "person");
  const places = entities.filter((e) => e.kind !== "person");

  return (
    <aside className="studio-drawer h-full w-[320px] flex-shrink-0 flex flex-col">
      <div className="px-5 py-4 border-b border-[var(--color-paper-edge)] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="studio-title text-lg">本章实体</h3>
          <p className="text-xs studio-subtle mt-0.5 truncate">
            {chapterLabel}
          </p>
        </div>
        <button
          onClick={onClose}
          className="studio-icon-button flex-shrink-0"
          aria-label="关闭"
        >
          x
        </button>
      </div>

      <div className="p-4 border-b border-[var(--color-paper-edge)]">
        {aiConfigured ? (
          <button
            onClick={onExtract}
            disabled={loading}
            className="studio-button studio-button-primary w-full"
          >
            {loading ? "提取中..." : entities.length > 0 ? "重新提取本章" : "提取人名、地名"}
          </button>
        ) : (
          <button
            onClick={onOpenSettings}
            className="studio-button studio-button-primary w-full"
          >
            去配置 AI
          </button>
        )}
        {error && (
          <p className="text-xs text-red-600 mt-3 leading-relaxed">{error}</p>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 py-4 space-y-5">
        {!loading && entities.length === 0 && !error && (
          <p className="text-sm studio-subtle leading-relaxed">
            点击上方按钮后，会分析当前章节，并在正文里给出现的人名、地名加下划线。
          </p>
        )}
        <EntityGroup
          title="人物"
          items={people}
          activeKey={activeKey}
          onSelect={onSelect}
        />
        <EntityGroup
          title="地点"
          items={places}
          activeKey={activeKey}
          onSelect={onSelect}
        />
      </div>
    </aside>
  );
}

function EntityGroup({
  title,
  items,
  activeKey,
  onSelect,
}: {
  title: string;
  items: EntityWithKey[];
  activeKey: string | null;
  onSelect: (entity: EntityWithKey) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4 className="text-xs studio-subtle tracking-[0.18em] mb-2">
        {title} · {items.length}
      </h4>
      <div className="space-y-2">
        {items.map((entity) => (
          <button
            key={entity.key}
            type="button"
            onClick={() => onSelect(entity)}
            className={`w-full text-left px-3 py-2.5 rounded-md border transition ${
              activeKey === entity.key
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                : "border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)]/55 hover:border-[var(--color-accent)]/50"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  entity.kind === "person"
                    ? "bg-[var(--color-accent)]"
                    : "bg-[var(--color-blue)]"
                }`}
              />
              <span className="font-medium text-sm text-[var(--color-ink)]">
                {entity.name}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed studio-subtle">
              {entity.summary}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}
