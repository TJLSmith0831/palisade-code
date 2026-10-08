import { profileStorage as localStorage } from "./profileStorage";
// Which files a reviewer has already looked at, per thread. This is a
// per-reviewer convenience, not evidence: it says "I read this", never that
// the change is correct. Storage is best-effort — a private window or blocked
// site data makes every read an empty set, which is the honest default.

const key = (threadId: string) => `palisade.review.${threadId}`;

export function loadViewed(threadId: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(threadId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/** Returns the new set even when the write fails, so the UI still updates. */
export function setViewed(threadId: string, path: string, viewed: boolean): Set<string> {
  const next = loadViewed(threadId);
  if (viewed) next.add(path);
  else next.delete(path);
  try {
    localStorage.setItem(key(threadId), JSON.stringify([...next]));
  } catch {
    /* storage unavailable — the session keeps the set in memory */
  }
  return next;
}

export function clearViewed(threadId: string): void {
  try {
    localStorage.removeItem(key(threadId));
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}
