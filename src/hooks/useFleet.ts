import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import { errorMessage } from "../errors";
import type { Envelope, FleetRow } from "../api";
import { CHAINS_CHANGED_EVENT } from "../ChainsPanel";

/** The fleet board's rows, kept fresh three ways: once when it goes active, on every
 *  executor envelope (the only event that means a run moved), and on a slow
 *  poll for the things no event announces — a verify finishing elsewhere, a
 *  branch moving under us.
 *
 *  An agent streams many envelopes a second and every fetch walks every open
 *  thread, so triggers are coalesced: at most one fetch in flight, and at
 *  least `minGapMs` between starts. A trigger that lands mid-fetch or inside the
 *  gap runs once, after it, so the board still ends on the newest state. */
export function useFleet({
  active,
  pollMs = 10_000,
  minGapMs = 1_000,
}: {
  active: boolean;
  pollMs?: number;
  minGapMs?: number;
}): {
  rows: FleetRow[];
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
} {
  const [rows, setRows] = useState<FleetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  // Bumped when the board goes inactive, so a fetch still in flight for the
  // project being left can't land afterwards and put its rows back.
  const generation = useRef(0);

  const inFlight = useRef(false);
  /** A trigger arrived while a fetch was running. */
  const rerun = useRef(false);
  const lastStart = useRef(0);
  const wake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Coalescing entry point for event/poll triggers; set by the effect below. */
  const trigger = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    const mine = generation.current;
    inFlight.current = true;
    lastStart.current = Date.now();
    try {
      const next = await api.fleetOverview();
      if (mine !== generation.current) return;
      setRows(next);
      setError(undefined);
    } catch (e) {
      if (mine !== generation.current) return;
      setError(errorMessage(e));
    } finally {
      if (mine === generation.current) setLoading(false);
      inFlight.current = false;
      if (rerun.current) {
        rerun.current = false;
        trigger.current();
      }
    }
  }, []);

  // `fleet_overview` only reports projects a window is showing, and the window
  // isn't tracked until a project has finished opening. So `active` means
  // "tracked", not just "chosen": a fetch any earlier answers `[]`, ends the
  // loading state, and the board says "No runs yet" (or keeps the last
  // project's rows) until the poll catches up. Going inactive drops the rows
  // and returns to loading, so a switch shows the skeleton, never stale rows.
  useEffect(() => {
    if (!active) {
      generation.current += 1;
      setRows([]);
      setLoading(true);
      return;
    }
    trigger.current = () => {
      if (inFlight.current) {
        rerun.current = true;
        return;
      }
      const wait = lastStart.current + minGapMs - Date.now();
      if (wait <= 0) {
        void refresh();
        return;
      }
      wake.current ??= setTimeout(() => {
        wake.current = undefined;
        trigger.current();
      }, wait);
    };
    void refresh();
    const un = listen<Envelope>("executor-event", () => trigger.current());
    const chainsChanged = () => trigger.current();
    window.addEventListener(CHAINS_CHANGED_EVENT, chainsChanged);
    const timer = setInterval(() => trigger.current(), pollMs);
    return () => {
      clearTimeout(wake.current);
      wake.current = undefined;
      rerun.current = false;
      trigger.current = () => {};
      clearInterval(timer);
      window.removeEventListener(CHAINS_CHANGED_EVENT, chainsChanged);
      void un.then((off) => off());
    };
  }, [active, pollMs, minGapMs, refresh]);

  return { rows, loading, error, refresh };
}
