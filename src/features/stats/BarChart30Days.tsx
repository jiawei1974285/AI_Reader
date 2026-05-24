import { useEffect, useMemo, useState } from "react";
import { dayKeyOf, ipc, type CalendarDay } from "@/lib/ipc";

/**
 * C2 — 近 N 天阅读时长柱图。
 *
 * 数据复用 list_calendar_days IPC（reading_sessions 表，A 阶段之后双写双存）。
 * 纯 SVG 渲染，不引入 chart 库 — 30 个柱子的需求体量犯不上拉一个 d3/echarts。
 *
 * 设计 (CLAUDE.md 原则 19 信息处理: 抽取信号而非数据堆):
 *   - 柱高 = 当日 read_time_ms 占当周期最大值的比例
 *   - 周末用浅色区分（视觉锚点）
 *   - 顶部显示 N 天总时长 + 平均 + 活跃天数比例
 *   - hover 单柱显示具体数值
 */
export function BarChart30Days({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<Map<number, CalendarDay>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1));
    const fromDay = dayKeyOf(start);
    const toDay = dayKeyOf(today);
    ipc
      .listCalendarDays(fromDay, toDay)
      .then((rs) => {
        if (cancelled) return;
        const m = new Map<number, CalendarDay>();
        for (const r of rs) m.set(r.day_key, r);
        setData(m);
      })
      .catch(() => {
        if (!cancelled) setData(new Map());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  // 构造连续 N 天数组（含空白日 = ms 0）
  const series = useMemo(() => {
    const today = new Date();
    const out: Array<{ date: Date; key: number; ms: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = dayKeyOf(d);
      const day = data.get(key);
      out.push({ date: d, key, ms: day?.total_ms ?? 0 });
    }
    return out;
  }, [data, days]);

  const summary = useMemo(() => {
    const totalMs = series.reduce((acc, d) => acc + d.ms, 0);
    const activeDays = series.filter((d) => d.ms > 0).length;
    const maxMs = series.reduce((acc, d) => Math.max(acc, d.ms), 0);
    const avgMs = activeDays > 0 ? Math.round(totalMs / activeDays) : 0;
    return { totalMs, activeDays, maxMs, avgMs };
  }, [series]);

  // SVG sizing — let the parent be responsive, but compute on a fixed grid
  const W = 600; // viewBox width
  const H = 140; // viewBox height
  const padL = 32; // 左轴
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barGap = 2;
  const barW = Math.max(1, (chartW - barGap * (series.length - 1)) / series.length);

  return (
    <div className="studio-panel p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-serif text-base text-[var(--color-ink)]">
          近 {days} 天阅读
        </h3>
        <div className="text-xs studio-subtle tabular-nums">
          {loading
            ? "—"
            : `活跃 ${summary.activeDays}/${days} 天 · 共 ${formatDuration(summary.totalMs)} · 日均 ${formatDuration(summary.avgMs)}`}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-32"
        preserveAspectRatio="none"
      >
        {/* 横向参考线 (0, 50%, 100% 高度处) */}
        {[0.25, 0.5, 0.75, 1].map((r) => (
          <line
            key={r}
            x1={padL}
            x2={W - padR}
            y1={padT + chartH * (1 - r)}
            y2={padT + chartH * (1 - r)}
            stroke="currentColor"
            strokeOpacity={0.08}
            strokeWidth={1}
          />
        ))}

        {/* 柱子 */}
        {series.map((d, i) => {
          const ratio = summary.maxMs === 0 ? 0 : d.ms / summary.maxMs;
          const h = Math.max(d.ms > 0 ? 2 : 0, ratio * chartH);
          const x = padL + i * (barW + barGap);
          const y = padT + chartH - h;
          const weekday = d.date.getDay();
          const isWeekend = weekday === 0 || weekday === 6;
          return (
            <g key={d.key}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                fill="var(--color-accent)"
                fillOpacity={isWeekend ? 0.55 : 0.85}
                rx={1}
              >
                <title>
                  {`${d.date.getFullYear()}-${d.date.getMonth() + 1}-${d.date.getDate()} · ${formatDuration(d.ms)}`}
                </title>
              </rect>
            </g>
          );
        })}

        {/* X 轴标签：每 7 天一格 (起、起+7、起+14、…、今天) */}
        {series.map((d, i) => {
          if (i !== 0 && i !== series.length - 1 && i % 7 !== 0) return null;
          const x = padL + i * (barW + barGap) + barW / 2;
          const label = `${d.date.getMonth() + 1}/${d.date.getDate()}`;
          return (
            <text
              key={`xlbl-${d.key}`}
              x={x}
              y={H - 6}
              fontSize={9}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.5}
            >
              {label}
            </text>
          );
        })}

        {/* Y 轴标签：max */}
        <text
          x={4}
          y={padT + 8}
          fontSize={9}
          fill="currentColor"
          opacity={0.5}
        >
          {summary.maxMs > 0 ? formatDurationShort(summary.maxMs) : ""}
        </text>
        <text
          x={4}
          y={H - padB}
          fontSize={9}
          fill="currentColor"
          opacity={0.5}
        >
          0
        </text>
      </svg>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function formatDurationShort(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h`;
}
