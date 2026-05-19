import type { ReactNode } from "react";
import type { AiSettings } from "@/lib/ipc";

type Props = {
  settings: AiSettings;
  onChange: (next: AiSettings) => void;
  onClose: () => void;
};

const AI_PRESETS: { label: string; base_url: string; model: string }[] = [
  { label: "OpenAI", base_url: "https://api.openai.com", model: "gpt-4o-mini" },
  { label: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-chat" },
  { label: "Moonshot", base_url: "https://api.moonshot.cn", model: "moonshot-v1-8k" },
  { label: "智谱", base_url: "https://open.bigmodel.cn/api/paas", model: "glm-4-flash" },
  { label: "Claude", base_url: "https://api.anthropic.com", model: "claude-3-5-sonnet-latest" },
];

export function GlobalAiSettingsPanel({
  settings,
  onChange,
  onClose,
}: Props) {
  function update<K extends keyof AiSettings>(key: K, value: AiSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div className="absolute inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-[var(--color-ink)]/10 backdrop-blur-[2px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="studio-drawer relative h-full w-[22rem] overflow-auto"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between">
          <div>
            <h3 className="studio-title text-lg">AI 设置</h3>
            <p className="text-xs studio-subtle mt-0.5">
              全局大模型接口，阅读和整理都会使用这里的配置
            </p>
          </div>
          <button onClick={onClose} className="studio-icon-button" aria-label="Close">
            x
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 text-sm text-[var(--color-ink)]">
          <SettingBlock label="服务商">
            <div className="grid grid-cols-2 gap-1">
              {AI_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() =>
                    onChange({
                      ...settings,
                      base_url: preset.base_url,
                      chat_model: settings.chat_model || preset.model,
                    })
                  }
                  className={`studio-segment text-left ${
                    settings.base_url === preset.base_url
                      ? "studio-segment-active"
                      : ""
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SettingBlock>

          <SettingBlock label="Base URL">
            <input
              type="text"
              value={settings.base_url}
              onChange={(e) => update("base_url", e.target.value)}
              placeholder="https://api.openai.com"
              className="studio-input w-full text-xs font-mono"
            />
          </SettingBlock>

          <SettingBlock label="API Key">
            <input
              type="password"
              value={settings.api_key}
              onChange={(e) => update("api_key", e.target.value)}
              placeholder="sk-..."
              className="studio-input w-full text-xs font-mono"
            />
          </SettingBlock>

          <SettingBlock label="对话模型">
            <input
              type="text"
              value={settings.chat_model}
              onChange={(e) => update("chat_model", e.target.value)}
              placeholder="gpt-4o-mini / deepseek-chat"
              className="studio-input w-full text-xs font-mono"
            />
          </SettingBlock>

          <SettingBlock label="快速模式">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.fast_mode ?? true}
                onChange={(e) => update("fast_mode", e.target.checked)}
                className="mt-1 w-4 h-4 accent-[var(--color-accent)]"
              />
              <span className="text-xs leading-relaxed">
                <span className="text-[var(--color-ink)]">关闭思考链</span>
                <span className="block studio-subtle mt-0.5">
                  适合阅读问答、分类、推荐等日常场景，通常响应更快。
                </span>
              </span>
            </label>
          </SettingBlock>
        </div>
      </aside>
    </div>
  );
}

function SettingBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs studio-subtle tracking-widest">{label}</span>
      </div>
      {children}
    </div>
  );
}
