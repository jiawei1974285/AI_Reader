import { useCallback, useEffect, useMemo, useState } from "react";
import {
  dateOfDayKey,
  dayKeyOf,
  ipc,
  type Book,
  type CalendarDay,
  type DayReading,
} from "@/lib/ipc";

type Props = {
  /** 点击当天某本书时跳转 — 由父组件接到 reader。 */
  onOpenBook?: (book: Book) => void;
};

/**
 * 月历视图 + 当日详情面板。
 *
 * - 顶部：上/下月切换 + 当前月份标题
 * - 中部：7×N 网格，有阅读活动的日 cell 强调显示（强度按当日 read_time_ms 分桶）
 * - 底部：选中某天后，按"阅读时长 / 高亮 / 书签"三栏展示当日详情
 *
 * 数据来源：
 * - `list_calendar_days(from_day, to_day)` 给每天的总时长 + 涉及书数（用于热度色块）
 * - `get_day_reading(day_key, start_ms, end_ms)` 给当天所有书的明细 + 高亮 + 书签
 */
export function ReadingCalendar({ onOpenBook }: Props) {
  const today = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-based
  const [monthData, setMonthData] = useState<Map<number, CalendarDay>>(
    new Map(),
  );
  const [selectedKey, setSelectedKey] = useState<number | null>(
    dayKeyOf(today),
  );
  const [dayDetail, setDayDetail] = useState<DayReading | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [allBooksById, setAllBooksById] = useState<Map<number, Book>>(new Map());

  // 预取一次 books 列表，用于"点击当天某本书"跳转
  useEffect(() => {
    ipc
      .listBooks()
      .then((bs) => {
        const m = new Map<number, Book>();
        for (const b of bs) m.set(b.id, b);
        setAllBooksById(m);
      })
      .catch(() => {});
  }, []);

  // 加载当前显示月份的所有活跃日（用于网格高亮）
  useEffect(() => {
    let cancelled = false;
    const first = new Date(viewYear, viewMonth, 1);
    const last = new Date(viewYear, viewMonth + 1, 0);
    const fromDay = dayKeyOf(first);
    const toDay = dayKeyOf(last);
    ipc
      .listCalendarDays(fromDay, toDay)
      .then((days) => {
        if (cancelled) return;
        const m = new Map<number, CalendarDay>();
        for (const d of days) m.set(d.day_key, d);
        setMonthData(m);
      })
      .catch(() => {
        if (!cancelled) setMonthData(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [viewYear, viewMonth]);

  // 加载选中日的详情
  useEffect(() => {
    if (!selectedKey) {
      setDayDetail(null);
      return;
    }
    let cancelled = false;
    setDayLoading(true);
    const d = dateOfDayKey(selectedKey);
    const startMs = d.getTime();
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const endMs = next.getTime();
    ipc
      .getDayReading(selectedKey, startMs, endMs)
      .then((data) => {
        if (cancelled) return;
        setDayDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDayDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey]);

  // 月份网格：把 1 号那天的 weekday 算出来，前面填空格
  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
    const startWeekday = first.getDay(); // 0=Sun
    const out: Array<{ day: number; key: number } | null> = [];
    for (let i = 0; i < startWeekday; i++) out.push(null);
    for (let d = 1; d <= lastDay; d++) {
      const key = viewYear * 10000 + (viewMonth + 1) * 100 + d;
      out.push({ day: d, key });
    }
    // 补全最后一行
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [viewYear, viewMonth]);

  const stepMonth = useCallback((delta: number) => {
    setViewMonth((m) => {
      let nm = m + delta;
      let ny = viewYear;
      while (nm < 0) {
        nm += 12;
        ny -= 1;
      }
      while (nm > 11) {
        nm -= 12;
        ny += 1;
      }
      setViewYear(ny);
      return nm;
    });
  }, [viewYear]);

  const monthLabel = `${viewYear} 年 ${viewMonth + 1} 月`;
  const todayKey = dayKeyOf(today);

  // 当月总时长 + 阅读天数（顶部 banner）
  const monthlySummary = useMemo(() => {
    let totalMs = 0;
    let dayCount = 0;
    for (const v of monthData.values()) {
      totalMs += v.total_ms;
      dayCount += 1;
    }
    return { totalMs, dayCount };
  }, [monthData]);

  return (
    <div className="studio-panel p-5">
      {/* 顶部：月切换 + 总览 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => stepMonth(-1)}
            className="studio-button px-2 py-1 text-sm"
            aria-label="上个月"
          >
            ←
          </button>
          <h3 className="font-serif text-lg text-[var(--color-ink)] mx-2 tabular-nums">
            {monthLabel}
          </h3>
          <button
            onClick={() => stepMonth(1)}
            className="studio-button px-2 py-1 text-sm"
            aria-label="下个月"
          >
            →
          </button>
          <button
            onClick={() => {
              const t = new Date();
              setViewYear(t.getFullYear());
              setViewMonth(t.getMonth());
              setSelectedKey(dayKeyOf(t));
            }}
            className="studio-button px-3 py-1 text-xs ml-2"
          >
            今天
          </button>
        </div>
        <div className="text-xs studio-subtle tabular-nums">
          本月阅读 {monthlySummary.dayCount} 天 · {formatDuration(monthlySummary.totalMs)}
        </div>
      </div>

      {/* 网格 */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div
            key={w}
            className="text-center text-[10px] studio-subtle tracking-widest py-1"
          >
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} className="aspect-square" />;
          const data = monthData.get(cell.key);
          const totalMs = data?.total_ms ?? 0;
          const heatLevel = heatLevelOf(totalMs);
          const isSelected = selectedKey === cell.key;
          const isToday = cell.key === todayKey;
          return (
            <button
              key={cell.key}
              onClick={() => setSelectedKey(cell.key)}
              className={[
                "aspect-square rounded text-xs flex flex-col items-center justify-center transition relative",
                "border",
                isSelected
                  ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                  : "border-[var(--color-paper-edge)]/40 hover:border-[var(--color-paper-edge)]",
                heatClass(heatLevel),
              ].join(" ")}
              title={
                data
                  ? `${formatDuration(totalMs)} · ${data.book_count} 本`
                  : "无阅读记录"
              }
            >
              <span
                className={
                  isToday
                    ? "font-bold text-[var(--color-accent)]"
                    : "text-[var(--color-ink)]"
                }
              >
                {cell.day}
              </span>
              {data ? (
                <span className="text-[9px] studio-subtle tabular-nums mt-0.5">
                  {formatDurationShort(totalMs)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 当日详情 */}
      <div className="mt-5 pt-4 border-t border-[var(--color-paper-edge)]/50">
        {selectedKey ? (
          <DayDetail
            dayKey={selectedKey}
            loading={dayLoading}
            data={dayDetail}
            onOpenBook={(bookId) => {
              const b = allBooksById.get(bookId);
              if (b && onOpenBook) onOpenBook(b);
            }}
          />
        ) : (
          <p className="text-xs studio-subtle">点击日历里的一天查看详情。</p>
        )}
      </div>
    </div>
  );
}

function DayDetail({
  dayKey,
  loading,
  data,
  onOpenBook,
}: {
  dayKey: number;
  loading: boolean;
  data: DayReading | null;
  onOpenBook: (bookId: number) => void;
}) {
  const d = dateOfDayKey(dayKey);
  const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    d.getDay()
  ];

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-3">
        <h4 className="font-serif text-base text-[var(--color-ink)]">{label}</h4>
        <span className="text-xs studio-subtle">{weekday}</span>
      </div>

      {loading ? (
        <p className="text-xs studio-subtle">加载中…</p>
      ) : !data ||
        (data.sessions.length === 0 &&
          data.highlights.length === 0 &&
          data.bookmarks.length === 0) ? (
        <p className="text-xs studio-subtle leading-relaxed py-2">
          这天没有阅读活动。
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <DaySection title={`阅读 ${data.sessions.length} 本`}>
            {data.sessions.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1.5">
                {data.sessions.map((s) => (
                  <li
                    key={s.book_id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[var(--color-paper-edge)]/30 cursor-pointer"
                    onClick={() => onOpenBook(s.book_id)}
                    title={s.book_author}
                  >
                    <span className="flex-1 truncate text-[var(--color-ink)]">
                      {s.book_title}
                    </span>
                    <span className="text-[var(--color-accent)] tabular-nums">
                      {formatDuration(s.read_time_ms)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DaySection>

          <DaySection title={`高亮 ${data.highlights.length} 条`}>
            {data.highlights.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1.5">
                {data.highlights.slice(0, 20).map((h) => (
                  <li
                    key={h.id}
                    className="px-2 py-1.5 rounded text-xs hover:bg-[var(--color-paper-edge)]/30 cursor-pointer border-l-2"
                    style={{
                      borderColor: highlightColorOf(h.color),
                    }}
                    onClick={() => onOpenBook(h.book_id)}
                    title={`《${h.book_title}》— 第 ${h.spine_index + 1} 章`}
                  >
                    <div className="text-[var(--color-ink)] line-clamp-2">
                      {h.selected_text}
                    </div>
                    <div className="text-[10px] studio-subtle mt-0.5 truncate">
                      《{h.book_title}》
                    </div>
                  </li>
                ))}
                {data.highlights.length > 20 ? (
                  <li className="text-[10px] studio-subtle px-2">
                    还有 {data.highlights.length - 20} 条…
                  </li>
                ) : null}
              </ul>
            )}
          </DaySection>

          <DaySection title={`书签 ${data.bookmarks.length} 条`}>
            {data.bookmarks.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1.5">
                {data.bookmarks.slice(0, 20).map((b) => (
                  <li
                    key={b.id}
                    className="px-2 py-1.5 rounded text-xs hover:bg-[var(--color-paper-edge)]/30 cursor-pointer"
                    onClick={() => onOpenBook(b.book_id)}
                  >
                    <div className="text-[var(--color-ink)] truncate">
                      {b.label || "未命名书签"}
                    </div>
                    {b.excerpt ? (
                      <div className="text-[10px] studio-subtle mt-0.5 line-clamp-2">
                        {b.excerpt}
                      </div>
                    ) : null}
                    <div className="text-[10px] studio-subtle mt-0.5 truncate">
                      《{b.book_title}》
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DaySection>
        </div>
      )}
    </div>
  );
}

function DaySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h5 className="text-[10px] studio-subtle tracking-[0.18em] uppercase mb-2">
        {title}
      </h5>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-[11px] studio-subtle leading-relaxed">—</p>;
}

// ---- 工具函数 ----

function formatDuration(ms: number): string {
  if (ms < 60_000) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function formatDurationShort(ms: number): string {
  if (ms < 60_000) return "";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  return `${h}h`;
}

/** 把阅读时长分成 0..4 共 5 个热度级，用来选色块强度。 */
function heatLevelOf(ms: number): 0 | 1 | 2 | 3 | 4 {
  if (ms <= 0) return 0;
  const min = ms / 60_000;
  if (min < 5) return 1;
  if (min < 20) return 2;
  if (min < 60) return 3;
  return 4;
}

function heatClass(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return "bg-transparent";
    case 1:
      return "bg-[var(--color-accent)]/15";
    case 2:
      return "bg-[var(--color-accent)]/30";
    case 3:
      return "bg-[var(--color-accent)]/55";
    case 4:
      return "bg-[var(--color-accent)]/85 text-white";
  }
}

function highlightColorOf(color: string): string {
  switch (color) {
    case "yellow":
      return "#facc15";
    case "green":
      return "#84cc5a";
    case "blue":
      return "#60a5fa";
    case "red":
      return "#fc645a";
    default:
      return "#facc15";
  }
}
