import { profileStorage as localStorage } from "../profileStorage";
import * as api from "../api";

export type CompletionTelemetry = {
  shown: number;
  accepted: number;
  dismissed: number;
  typedPast: number;
  /** Requests where the model declined to suggest anything (D60). Counted
   *  unthrottled — the status-bar notice is throttled, the measurement is not. */
  abstained: number;
  /** Accepted completions still present 30s later. Accepted-then-deleted is
   *  not an accepted completion, and this is the difference. */
  retained: number;
  ttftP50: number;
  ttftP99: number;
};

type StoredTelemetry = CompletionTelemetry & { _latencies: number[] };

const TELEMETRY_KEY = "palisade:completionTelemetry";

function emptyTelemetry(): StoredTelemetry {
  return {
    shown: 0,
    accepted: 0,
    dismissed: 0,
    typedPast: 0,
    abstained: 0,
    retained: 0,
    ttftP50: 0,
    ttftP99: 0,
    _latencies: [],
  };
}

export function loadTelemetry(): StoredTelemetry {
  try {
    const raw = localStorage.getItem(TELEMETRY_KEY);
    if (!raw) return emptyTelemetry();
    const parsed = JSON.parse(raw) as Partial<StoredTelemetry>;
    return {
      ...emptyTelemetry(),
      ...parsed,
      _latencies: Array.isArray(parsed._latencies) ? parsed._latencies : [],
    };
  } catch {
    return emptyTelemetry();
  }
}

function save(telemetry: StoredTelemetry) {
  localStorage.setItem(TELEMETRY_KEY, JSON.stringify(telemetry));
  void flush(telemetry);
}

export function flush(telemetry?: StoredTelemetry): Promise<void> {
  const t = telemetry ?? loadTelemetry();
  const { _latencies, ...publicTelemetry } = t;
  return api.flushCompletionTelemetry(publicTelemetry).catch(() => {});
}

export function getPublicTelemetry(): CompletionTelemetry {
  const { _latencies, ...rest } = loadTelemetry();
  return rest;
}

export function recordShown() {
  const t = loadTelemetry();
  t.shown += 1;
  save(t);
}

export function recordAccepted() {
  const t = loadTelemetry();
  t.accepted += 1;
  save(t);
}

export function recordDismissed() {
  const t = loadTelemetry();
  t.dismissed += 1;
  save(t);
}

export function recordTypedPast() {
  const t = loadTelemetry();
  t.typedPast += 1;
  save(t);
}

export function recordAbstained() {
  const t = loadTelemetry();
  t.abstained += 1;
  save(t);
}

export function recordRetained() {
  const t = loadTelemetry();
  t.retained += 1;
  save(t);
}

export function recordLatency(latencyMs: number) {
  const t = loadTelemetry();
  t._latencies.push(latencyMs);
  t._latencies = t._latencies.slice(-1000); // cap history
  t.ttftP50 = percentile(t._latencies, 0.5);
  t.ttftP99 = percentile(t._latencies, 0.99);
  save(t);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
