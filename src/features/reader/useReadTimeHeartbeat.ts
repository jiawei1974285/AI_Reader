import { useEffect } from "react";
import { dayKeyOf, ipc } from "@/lib/ipc";

/**
 * Accumulate reading time for the current book while the reader view is
 * mounted AND the window is visible. Pings the backend on a fixed
 * interval; the delta is clipped so an idled session doesn't bank false
 * hours. Pauses on tab hide / window blur and resumes on focus.
 *
 * Granularity: 30s tick. A user has to actually keep the window open
 * for at least one full tick before any time is recorded.
 */
const TICK_MS = 30_000;

export function useReadTimeHeartbeat(bookId: number) {
  useEffect(() => {
    if (!Number.isFinite(bookId) || bookId <= 0) return;

    let lastTick = Date.now();
    let visible = !document.hidden;

    const onVisibility = () => {
      visible = !document.hidden;
      lastTick = Date.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("blur", onVisibility);

    const id = window.setInterval(() => {
      if (!visible) {
        lastTick = Date.now();
        return;
      }
      const now = Date.now();
      // Clip to TICK_MS * 1.5 so any pause/system sleep doesn't bank
      // a huge delta in one go.
      const delta = Math.min(now - lastTick, TICK_MS * 1.5);
      lastTick = now;
      if (delta > 1000) {
        ipc
          .addReadTime(bookId, Math.floor(delta), dayKeyOf(new Date()))
          .catch(() => {});
      }
    }, TICK_MS);

    return () => {
      // On unmount, bank whatever time accumulated since the last tick
      const now = Date.now();
      if (visible) {
        const delta = Math.min(now - lastTick, TICK_MS * 1.5);
        if (delta > 1000) {
          ipc
          .addReadTime(bookId, Math.floor(delta), dayKeyOf(new Date()))
          .catch(() => {});
        }
      }
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onVisibility);
    };
  }, [bookId]);
}
