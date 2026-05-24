import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * B2 - 抽自 EpubView/PdfView 共用的全屏开关。
 *
 * 关心两件事：
 *   1. mount 时同步 OS 实际状态（用户可能上次没退出就关了 reader，
 *      再进来时 isFullscreen 还是 true）
 *   2. toggle 时既改 OS 又改 React state，两者一致
 *
 * 错误吞掉——Tauri window API 在非 Tauri 环境（如 vite dev preview）会抛，
 * 全屏不是核心阅读功能，挂了就当没这个功能。
 */
export function useFullscreen(): {
  fullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
} {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let mounted = true;
    getCurrentWindow()
      .isFullscreen()
      .then((v) => {
        if (mounted) setFullscreen(v);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  async function toggleFullscreen(): Promise<void> {
    try {
      const win = getCurrentWindow();
      const isFs = await win.isFullscreen();
      await win.setFullscreen(!isFs);
      setFullscreen(!isFs);
    } catch {
      // ignore
    }
  }

  return { fullscreen, toggleFullscreen };
}
