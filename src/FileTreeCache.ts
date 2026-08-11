import { useCallback, useRef, useState } from "react";

const BURST_MS = 50;

type Cache = {
  version: number;
  timer: number | null;
};

/** A coalescing file-tree refresh signal.
 *
 * `invalidate(path)` can be called in a tight burst (e.g. an agent turn
 * writing many files); the returned `refreshToken` only bumps once per burst,
 * avoiding repeated full tree walks. The path is recorded for future
 * per-directory invalidation; today the tree still performs a single full
 * refresh after each coalesced burst. */
export function useFileTreeCache() {
  const [refreshToken, setRefreshToken] = useState(0);
  const cache = useRef<Cache>({ version: 0, timer: null });

  const invalidate = useCallback((path: string) => {
    // Avoid closing over the token; always read the latest ref.
    const current = cache.current;
    if (current.timer) window.clearTimeout(current.timer);
    current.timer = window.setTimeout(() => {
      current.version += 1;
      current.timer = null;
      setRefreshToken(current.version);
    }, BURST_MS);
    // `path` is kept for future surgical invalidation; currently only the
    // burst-merged token is used.
    void path;
  }, []);

  return { refreshToken, invalidate } as const;
}
