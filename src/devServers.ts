import { originOf } from "./detectDevServerUrl";

/** Where a candidate URL was first seen. */
export type ServerOrigin = "terminal" | "agent";

export type DevServer = { url: string; origin: ServerOrigin };

type Candidate = DevServer & { live: boolean; misses: number };

/** A server that has answered is dropped after this many failed checks in a
 * row: one miss is a slow reply or a restart, two is gone. */
export const MISSES_WHEN_LIVE = 2;

/** A URL that has never answered is given this many checks before being
 * forgotten — a server prints its banner a moment before it listens, and an
 * agent may name a URL that was never a server at all. */
export const MISSES_BEFORE_LIVE = 10;

/**
 * The dev servers worth offering, and only those that are running.
 *
 * Detection is cheap and unreliable — a URL in a README, a log line or an
 * agent's prose all match — so a candidate is never shown on sight. It is
 * probed, and it appears once something answers and disappears once nothing
 * does. That check, not the pattern, is what makes a chip trustworthy.
 *
 * Kept free of React and timers so the state machine can be tested with a
 * fake probe; `useDevServers` owns the clock.
 */
export class DevServerTracker {
  private candidates = new Map<string, Candidate>();

  /** Notes a URL. A server already tracked keeps its state; only its
   * remembered page (the latest path the output named) is refreshed. */
  add(url: string, origin: ServerOrigin): void {
    const key = originOf(url);
    const known = this.candidates.get(key);
    if (known) {
      known.url = url;
      return;
    }
    this.candidates.set(key, { url, origin, live: false, misses: 0 });
  }

  clear(): void {
    this.candidates.clear();
  }

  /** Forgets one server, e.g. one the user dismissed. */
  remove(url: string): void {
    this.candidates.delete(originOf(url));
  }

  get size(): number {
    return this.candidates.size;
  }

  /** Probes every candidate once. Resolves true when the visible list changed. */
  async check(reachable: (url: string) => Promise<boolean>): Promise<boolean> {
    const before = this.signature();
    await Promise.all(
      [...this.candidates.entries()].map(async ([key, candidate]) => {
        const ok = await reachable(candidate.url).catch(() => false);
        // The candidate may have been removed while the probe was in flight.
        if (this.candidates.get(key) !== candidate) return;
        if (ok) {
          candidate.live = true;
          candidate.misses = 0;
          return;
        }
        candidate.misses += 1;
        const limit = candidate.live ? MISSES_WHEN_LIVE : MISSES_BEFORE_LIVE;
        if (candidate.misses >= limit) this.candidates.delete(key);
      })
    );
    return before !== this.signature();
  }

  /** The servers that answered on the last check, oldest first. */
  live(): DevServer[] {
    return [...this.candidates.values()]
      .filter((candidate) => candidate.live)
      .map(({ url, origin }) => ({ url, origin }));
  }

  private signature(): string {
    return this.live()
      .map((server) => `${server.origin}|${server.url}`)
      .join("\n");
  }
}
