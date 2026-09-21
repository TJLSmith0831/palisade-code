import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(async () => {
    try {
      setRows(await api.fleetOverview());
      setError(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Not on mount: `fleet_overview` only reports projects a window is showing,
  // and the window isn't tracked until the project is open. A mount-time fetch
  // answers `[]`, ends the loading state, and the board says "No runs yet"
  // until the poll catches up. `loading` therefore stays true until the first
  // fetch that has a project behind it.
  useEffect(() => {
    if (!active) return;
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
