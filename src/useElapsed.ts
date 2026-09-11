import { useEffect, useState } from "react";

/**
 * Seconds since `startedAt`, ticking once a second while the run is live.
 *
 * Both run surfaces read `Date.now()` during render, and a chain re-renders
 * only when an event arrives — so a node that thinks for four minutes froze
 * the header at whatever it read last. A stopped clock on a live run reads as
 * a hung run, which is worse than showing no clock at all.
 *
 * Ticking stops once `endedAt` is set: a finished run's duration is fixed.
 */
export function useElapsed(startedAt?: string, endedAt?: string | null): number {
  const start = startedAt ? new Date(startedAt).getTime() : null;
  const end = endedAt ? new Date(endedAt).getTime() : null;
  const secondsBetween = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 1000));

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (start === null || end !== null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [start, end]);

  if (start === null) return 0;
  return secondsBetween(start, end ?? now);
}
