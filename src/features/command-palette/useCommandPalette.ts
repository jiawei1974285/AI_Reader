import { useCallback, useEffect, useState } from "react";

/**
 * C6 — 全局 Ctrl/Cmd+K 唤起命令面板。
 *
 * 监听挂在 window + capture phase，避免 reader 内 Ctrl+F 的逻辑或
 * WebView2 自带快捷键抢先。
 *
 * 用法：
 *   const { open, setOpen } = useCommandPalette();
 *   return <CommandPalette open={open} onClose={() => setOpen(false)} ... />
 */
export function useCommandPalette(): {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "k" || e.key === "K")
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle]);

  return { open, setOpen, toggle };
}
