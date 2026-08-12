import { beforeEach, describe, expect, it } from "vitest";
import {
  getPublicTelemetry,
  loadTelemetry,
  recordAccepted,
  recordDismissed,
  recordLatency,
  recordShown,
  recordTypedPast,
} from "../completion/telemetry";

describe("completion telemetry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts at zero", () => {
    const t = getPublicTelemetry();
    expect(t).toEqual({
      shown: 0,
      accepted: 0,
      dismissed: 0,
      typedPast: 0,
      ttftP50: 0,
      ttftP99: 0,
    });
    expect(loadTelemetry()._latencies).toEqual([]);
  });

  it("records counters", () => {
    recordShown();
    recordShown();
    recordAccepted();
    recordDismissed();
    recordTypedPast();

    const t = getPublicTelemetry();
    expect(t.shown).toBe(2);
    expect(t.accepted).toBe(1);
    expect(t.dismissed).toBe(1);
    expect(t.typedPast).toBe(1);
  });

  it("records latency and computes percentiles", () => {
    for (let i = 1; i <= 100; i++) {
      recordLatency(i);
    }
    const t = getPublicTelemetry();
    expect(t.ttftP50).toBe(50.5);
    expect(t.ttftP99).toBeCloseTo(99.01, 2);
  });

  it("loads persisted telemetry", () => {
    recordShown();
    recordAccepted();
    recordLatency(42);

    const t = loadTelemetry();
    expect(t.shown).toBe(1);
    expect(t.accepted).toBe(1);
    expect(t._latencies).toEqual([42]);
    expect(t.ttftP50).toBe(42);
  });
});
