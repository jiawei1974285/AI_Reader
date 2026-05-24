import { useEffect, useState } from "react";
import {
  DEFAULT_READER_SETTINGS,
  loadReaderSettings,
  saveReaderSettings,
  type ReaderSettings,
} from "@/lib/ipc";

/**
 * B2 - 把 EpubView/PdfView 共享的「reader 设置生命周期」收拢：
 *
 *   1. mount 时从 DB 拉 settings
 *   2. settings 变了 debounced (200ms) 写回 DB
 *   3. settings.theme 变了把 `<body data-theme="...">` 改掉，
 *      让全局 CSS 变量切换（牛皮纸/白底/深色三套主题）。unmount 时清掉
 *      body 的属性，避免 reader 退出后书架仍带 reader theme。
 *
 * 这一组之前在 EpubView 里散在 3 个 useEffect + 2 个 useState（48 行），
 * 抽成 hook 后调用方只一行 `const { settings, setSettings, settingsReady } = ...`。
 */
export function useReaderSettings(): {
  settings: ReaderSettings;
  setSettings: React.Dispatch<React.SetStateAction<ReaderSettings>>;
  settingsReady: boolean;
} {
  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS,
  );
  const [settingsReady, setSettingsReady] = useState(false);

  // 1. Initial load (one-shot)
  useEffect(() => {
    loadReaderSettings()
      .then(setSettings)
      .catch(() => {})
      .finally(() => setSettingsReady(true));
  }, []);

  // 2. Persist on change (debounced — 用户拖滑块时不会写穿 DB)
  useEffect(() => {
    if (!settingsReady) return;
    const t = window.setTimeout(() => {
      saveReaderSettings(settings).catch(() => {});
    }, 200);
    return () => window.clearTimeout(t);
  }, [settings, settingsReady]);

  // 3. Apply theme to body (so global CSS variables flip)
  useEffect(() => {
    document.body.setAttribute("data-theme", settings.theme);
    return () => {
      document.body.removeAttribute("data-theme");
    };
  }, [settings.theme]);

  return { settings, setSettings, settingsReady };
}
