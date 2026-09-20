import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import type { Envelope, FleetRow } from "../api";

/** The fleet board's rows, kept fresh three ways: once on mount, on every
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    const un = listen<Envelope>("executor-event", () => void refresh());
    const timer = setInterval(() => void refresh(), pollMs);
    return () => {
      clearInterval(timer);
      void un.then((off) => off());
    };
  }, [active, pollMs, refresh]);

  return { rows, loading, error, refresh };
}
