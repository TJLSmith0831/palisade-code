import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import type { Envelope, FleetRow } from "../api";
import { CHAINS_CHANGED_EVENT } from "../ChainsPanel";

/** The fleet board's rows, kept fresh three ways: once when it goes active, on every
 *  executor envelope (the only event that means a run moved), and on a slow
 *  poll for the things no event announces — a verify finishing elsewhere, a
 *  branch moving under us. */
export function useFleet({
  active,
  pollMs = 10_000,
}: {
  active: boolean;
  pollMs?: number;
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

  const refresh = useCallback(async () => {
    const mine = generation.current;
    try {
      const next = await api.fleetOverview();
      if (mine !== generation.current) return;
      setRows(next);
      setError(undefined);
    } catch (e) {
      if (mine !== generation.current) return;
      setError(String(e));
    } finally {
      if (mine === generation.current) setLoading(false);
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
    void refresh();
    const un = listen<Envelope>("executor-event", () => void refresh());
    const chainsChanged = () => void refresh();
    window.addEventListener(CHAINS_CHANGED_EVENT, chainsChanged);
    const timer = setInterval(() => void refresh(), pollMs);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHAINS_CHANGED_EVENT, chainsChanged);
      void un.then((off) => off());
    };
  }, [active, pollMs, refresh]);

  return { rows, loading, error, refresh };
}
