import { useState, type ReactNode } from "react";
import type { AiSettings, ReaderSettings as Settings } from "@/lib/ipc";
import { DEFAULT_READER_SETTINGS, ipc } from "@/lib/ipc";

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
  { label: "Moonshot", base_url: "https://api.moonshot.cn" },
  { label: "智谱", base_url: "https://open.bigmodel.cn/api/paas" },
  { label: "Claude", base_url: "https://api.anthropic.com" },
];

export function ReaderSettingsPanel({
  settings,
  onChange,
  aiSettings,
  onAiChange,
  onClose,
}: Props) {
  const [aiTestState, setAiTestState] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [aiTestMessage, setAiTestMessage] = useState("");

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function updateAi<K extends keyof AiSettings>(
    key: K,
    value: AiSettings[K],
  ) {
    if (!aiSettings || !onAiChange) return;
    onAiChange({ ...aiSettings, [key]: value });
    setAiTestState("idle");
    setAiTestMessage("");
  }

  async function testAiModel() {
    if (!aiSettings) return;
    setAiTestState("testing");
    setAiTestMessage("");
    try {
      const msg = await ipc.testAiModel(aiSettings);
      setAiTestState("success");
      setAiTestMessage(msg);
    } catch (e) {
      setAiTestState("error");
      setAiTestMessage(String(e));
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-[var(--color-ink)]/10 backdrop-blur-[2px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="studio-drawer relative h-full w-[21rem] bg-[var(--color-paper-soft)] overflow-auto"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between">
          <div>
            <h3 className="studio-title text-lg">阅读设置</h3>
            <p className="text-xs studio-subtle mt-0.5">排版、主题与 AI 服务</p>
          </div>
          <button onClick={onClose} className="studio-icon-button" aria-label="Close">
            x
          </button>
        </div>

        <div className="px-6 py-5 space-y-6 text-sm text-[var(--color-ink)]">
          <Section label="阅读模式">
            <Segmented
              value={settings.reading_mode ?? "scroll"}
              onChange={(v) => update("reading_mode", v)}
              options={[
                { value: "scroll", label: "滚动阅读" },
                { value: "paged", label: "横向翻页" },
              ]}
            />
          </Section>

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

          <Section label="字号" value={`${settings.font_size}px`}>
            <input
              type="range"
              min={14}
              max={24}
              step={1}
              value={settings.font_size}
              onChange={(e) => update("font_size", Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
            />
          </Section>

          <Section label="行距" value={settings.line_height.toFixed(1)}>
            <input
              type="range"
              min={1.4}
              max={2.6}
              step={0.1}
              value={settings.line_height}
              onChange={(e) => update("line_height", Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
            />
          </Section>

          <Section label="栏宽" value={`${settings.column_width} 字`}>
            <input
              type="range"
              min={28}
              max={64}
              step={2}
              value={settings.column_width}
              onChange={(e) => update("column_width", Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
            />
          </Section>

          <Section label="主题">
            <div className="grid grid-cols-3 gap-2">
              <ThemeSwatch
                active={settings.theme === "cream"}
                onClick={() => update("theme", "cream")}
                paper="#f6efe0"
                ink="#2a2419"
                label="纸感"
              />
              <ThemeSwatch
                active={settings.theme === "white"}
                onClick={() => update("theme", "white")}
                paper="#fbfbfa"
                ink="#1a1a1a"
                label="素白"
              />
              <ThemeSwatch
                active={settings.theme === "dark"}
                onClick={() => update("theme", "dark")}
                paper="#1f1d18"
                ink="#e3dac8"
                label="夜读"
              />
            </div>
          </Section>

          <Section label="段首缩进">
            <Segmented
              value={settings.paragraph_indent ? "on" : "off"}
              onChange={(v) => update("paragraph_indent", v === "on")}
              options={[
                { value: "on", label: "缩进 2 字" },
                { value: "off", label: "段间距" },
              ]}
            />
          </Section>

          <button
            onClick={() => onChange(DEFAULT_READER_SETTINGS)}
            className="studio-button"
          >
            恢复默认
          </button>

          {aiSettings && onAiChange && (
            <>
              <div className="pt-4 mt-4 border-t border-[var(--color-paper-edge)]">
                <h4 className="studio-title text-base mb-1">AI 接口</h4>
                <p className="text-xs studio-subtle mb-4 leading-relaxed">
                  支持 OpenAI 兼容协议。填写 base_url、api_key 和 model 即可。
                </p>
              </div>

              <Section label="服务">
                <div className="grid grid-cols-2 gap-1">
                  {AI_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => updateAi("base_url", p.base_url)}
                      className={`studio-segment text-left ${
                        aiSettings.base_url === p.base_url
                          ? "studio-segment-active"
                          : ""
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
                  className="studio-input w-full text-xs font-mono"
                />
              </Section>

              <Section label="API Key">
                <input
                  type="password"
                  value={aiSettings.api_key}
                  onChange={(e) => updateAi("api_key", e.target.value)}
                  placeholder="sk-..."
                  className="studio-input w-full text-xs font-mono"
                />
              </Section>

              <Section label="对话模型">
                <input
                  type="text"
                  value={aiSettings.chat_model}
                  onChange={(e) => updateAi("chat_model", e.target.value)}
                  placeholder="gpt-4o-mini / deepseek-v4-pro"
                  className="studio-input w-full text-xs font-mono"
                />
                <p className="mt-2 text-[10px] studio-subtle leading-relaxed">
                  ⚡ DeepSeek 用 <span className="font-mono">deepseek-v4-pro</span>{" "}
                  最快（V3 非思考版）。要更深度的推理可用{" "}
                  <span className="font-mono">deepseek-reasoner</span>，但开启快速模式时
                  其思考链会被自动过滤。
                </p>
              </Section>

              <Section label="快速模式">
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={aiSettings.fast_mode ?? true}
                    onChange={(e) => updateAi("fast_mode", e.target.checked)}
                    className="mt-1 w-4 h-4 accent-[var(--color-accent)]"
                  />
                  <span className="text-xs leading-relaxed">
                    <span className="text-[var(--color-ink)]">关闭思考链</span>
                    <span className="block studio-subtle mt-0.5">
                      在请求里加 <span className="font-mono">enable_thinking: false</span>
                      ，并过滤回答里 <span className="font-mono">&lt;think&gt;…&lt;/think&gt;</span>{" "}
                      块。该字段只会发给 DeepSeek/Qwen 等支持的接口。
                    </span>
                  </span>
                </label>
              </Section>

              <div className="pt-1">
                <button
                  onClick={testAiModel}
                  disabled={aiTestState === "testing"}
                  className="studio-button w-full disabled:opacity-50 disabled:cursor-wait"
                >
                  {aiTestState === "testing" ? "测试中..." : "测试模型连接"}
                </button>
                {aiTestMessage && (
                  <p
                    className={`mt-2 text-xs leading-relaxed whitespace-pre-wrap ${
                      aiTestState === "success"
                        ? "text-[var(--color-accent)]"
                        : "text-red-600"
                    }`}
                  >
                    {aiTestMessage}
                  </p>
                )}
              </div>
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
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs studio-subtle tracking-widest">{label}</span>
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
    <div className="studio-segmented grid-cols-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`studio-segment ${
            value === opt.value ? "studio-segment-active" : ""
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
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/8"
          : "border-[var(--color-paper-edge)] hover:border-[var(--color-accent)]/35"
      }`}
    >
      <div
        className="w-full h-10 rounded flex items-center justify-center font-serif text-base border border-black/5"
        style={{ background: paper, color: ink }}
      >
        文
      </div>
      <span className="text-[11px] studio-subtle">{label}</span>
    </button>
  );
}
