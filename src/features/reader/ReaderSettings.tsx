import type {
  AiSettings,
  ReaderSettings as Settings,
} from "@/lib/ipc";
import { DEFAULT_READER_SETTINGS } from "@/lib/ipc";

type Props = {
  settings: Settings;
  onChange: (next: Settings) => void;
  aiSettings?: AiSettings;
  onAiChange?: (next: AiSettings) => void;
  onClose: () => void;
};

const AI_PRESETS: { label: string; base_url: string }[] = [
  { label: "OpenAI", base_url: "https://api.openai.com" },
  { label: "DeepSeek", base_url: "https://api.deepseek.com" },
  { label: "Moonshot Kimi", base_url: "https://api.moonshot.cn" },
  { label: "智谱", base_url: "https://open.bigmodel.cn/api/paas" },
  { label: "Claude (Anthropic)", base_url: "https://api.anthropic.com" },
];

export function ReaderSettingsPanel({
  settings,
  onChange,
  aiSettings,
  onAiChange,
  onClose,
}: Props) {
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function updateAi<K extends keyof AiSettings>(
    key: K,
    value: AiSettings[K],
  ) {
    if (!aiSettings || !onAiChange) return;
    onAiChange({ ...aiSettings, [key]: value });
  }

  return (
    <div
      className="absolute inset-0 z-30 flex justify-end"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/10" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-80 bg-[var(--color-paper-soft)] border-l border-[var(--color-paper-edge)] shadow-xl overflow-auto"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between">
          <h3 className="font-serif text-lg text-[var(--color-ink)]">
            阅读设置
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/40 transition"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-6 text-sm text-[var(--color-ink)]">
          <Section label="字体">
            <Segmented
              value={settings.font_family}
              onChange={(v) => update("font_family", v)}
              options={[
                { value: "serif", label: "宋体" },
                { value: "sans", label: "黑体" },
              ]}
            />
          </Section>

          <Section
            label="字号"
            value={`${settings.font_size}px`}
          >
            <input
              type="range"
              min={14}
              max={24}
              step={1}
              value={settings.font_size}
              onChange={(e) => update("font_size", Number(e.target.value))}
              className="w-full accent-[var(--color-ink)]"
            />
          </Section>

          <Section
            label="行距"
            value={settings.line_height.toFixed(1)}
          >
            <input
              type="range"
              min={1.4}
              max={2.6}
              step={0.1}
              value={settings.line_height}
              onChange={(e) => update("line_height", Number(e.target.value))}
              className="w-full accent-[var(--color-ink)]"
            />
          </Section>

          <Section
            label="栏宽"
            value={`${settings.column_width} 字`}
          >
            <input
              type="range"
              min={28}
              max={64}
              step={2}
              value={settings.column_width}
              onChange={(e) => update("column_width", Number(e.target.value))}
              className="w-full accent-[var(--color-ink)]"
            />
          </Section>

          <Section label="主题">
            <div className="grid grid-cols-3 gap-2">
              <ThemeSwatch
                active={settings.theme === "cream"}
                onClick={() => update("theme", "cream")}
                paper="#f6efe0"
                ink="#2a2419"
                label="米黄"
              />
              <ThemeSwatch
                active={settings.theme === "white"}
                onClick={() => update("theme", "white")}
                paper="#fbfbfa"
                ink="#1a1a1a"
                label="米白"
              />
              <ThemeSwatch
                active={settings.theme === "dark"}
                onClick={() => update("theme", "dark")}
                paper="#1d1b16"
                ink="#d8d2c4"
                label="暗墨"
              />
            </div>
          </Section>

          <Section label="段首缩进">
            <Segmented
              value={settings.paragraph_indent ? "on" : "off"}
              onChange={(v) => update("paragraph_indent", v === "on")}
              options={[
                { value: "on", label: "缩进 2 字" },
                { value: "off", label: "无缩进" },
              ]}
            />
          </Section>

          <button
            onClick={() => onChange(DEFAULT_READER_SETTINGS)}
            className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] underline underline-offset-4 transition"
          >
            恢复默认
          </button>

          {aiSettings && onAiChange && (
            <>
              <div className="pt-4 mt-4 border-t border-[var(--color-paper-edge)]">
                <h4 className="font-serif text-base text-[var(--color-ink)] mb-1">
                  AI 接口
                </h4>
                <p className="text-xs text-[var(--color-muted)] mb-4 leading-relaxed">
                  支持 OpenAI 兼容协议。填入 base_url + api_key + model 即可。
                </p>
              </div>

              <Section label="服务">
                <div className="grid grid-cols-2 gap-1">
                  {AI_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => updateAi("base_url", p.base_url)}
                      className={`px-2 py-1.5 rounded text-xs text-left transition ${
                        aiSettings.base_url === p.base_url
                          ? "bg-[var(--color-paper-soft)] text-[var(--color-ink)] border border-[var(--color-ink)]/30"
                          : "bg-[var(--color-paper-edge)]/30 text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/50 border border-transparent"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </Section>

              <Section label="Base URL">
                <input
                  type="text"
                  value={aiSettings.base_url}
                  onChange={(e) => updateAi("base_url", e.target.value)}
                  placeholder="https://api.openai.com"
                  className="w-full px-3 py-1.5 text-xs rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper)] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]/40 font-mono"
                />
              </Section>

              <Section label="API Key">
                <input
                  type="password"
                  value={aiSettings.api_key}
                  onChange={(e) => updateAi("api_key", e.target.value)}
                  placeholder="sk-…"
                  className="w-full px-3 py-1.5 text-xs rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper)] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]/40 font-mono"
                />
              </Section>

              <Section label="对话模型">
                <input
                  type="text"
                  value={aiSettings.chat_model}
                  onChange={(e) => updateAi("chat_model", e.target.value)}
                  placeholder="例如 gpt-4o-mini, deepseek-chat, moonshot-v1-32k"
                  className="w-full px-3 py-1.5 text-xs rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper)] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]/40 font-mono"
                />
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs text-[var(--color-muted)] tracking-widest">
          {label}
        </span>
        {value && (
          <span className="text-xs text-[var(--color-ink-soft)] tabular-nums">
            {value}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--color-paper-edge)]/40 rounded-md">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded text-sm transition ${
            value === opt.value
              ? "bg-[var(--color-paper-soft)] text-[var(--color-ink)] shadow-sm"
              : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ThemeSwatch({
  active,
  onClick,
  paper,
  ink,
  label,
}: {
  active: boolean;
  onClick: () => void;
  paper: string;
  ink: string;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-md border transition ${
        active
          ? "border-[var(--color-ink)]/50"
          : "border-[var(--color-paper-edge)] hover:border-[var(--color-ink)]/20"
      }`}
    >
      <div
        className="w-full h-10 rounded flex items-center justify-center font-serif text-base"
        style={{ background: paper, color: ink }}
      >
        文
      </div>
      <span className="text-[11px] text-[var(--color-muted)]">{label}</span>
    </button>
  );
}
