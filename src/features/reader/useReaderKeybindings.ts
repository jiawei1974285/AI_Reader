import { useEffect } from "react";

type Handlers = {
  onOpenSearch: () => void;
};

/**
 * B2 - 把阅读器的全局键盘绑定抽出来。当前只有 Ctrl/Cmd+F 唤起书内搜索；
 * 之后加 Ctrl+P 上一章 / Ctrl+N 下一章 / Esc 退出查询气泡都加在这里。
 *
 * 重点：keydown 监听 **必须 capture phase** + 挂 window，否则 WebView2
 * 自带的查找工具栏会先一步抓到 Ctrl+F，我们的 preventDefault 没机会跑。
 */
export function useReaderKeybindings(handlers: Handlers): void {
  const { onOpenSearch } = handlers;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ctrl/Cmd + F (no shift, no alt) → 打开书内搜索
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        e.stopPropagation();
        onOpenSearch();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onOpenSearch]);
}
