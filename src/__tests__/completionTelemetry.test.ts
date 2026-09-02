import { beforeEach, describe, expect, it } from "vitest";
import {
  getPublicTelemetry,
  loadTelemetry,
  recordAccepted,
  recordDismissed,
  recordLatency,
  recordAbstained,
  recordRetained,
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
      abstained: 0,
      retained: 0,
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

  // Step 2 of the sequence: nothing else about inline completion can be
  // ranked without knowing whether anyone uses it. `retained` is the metric
  // worth having — accepted-then-deleted is not an accepted completion.
  it("counts abstentions separately from completions that were shown", () => {
    recordShown();
    recordAbstained();
    recordAbstained();

    const t = getPublicTelemetry();
    expect(t.shown).toBe(1);
    expect(t.abstained).toBe(2);
  });

  it("counts retention as a subset of acceptance", () => {
    recordAccepted();
    recordAccepted();
    recordRetained();

    const t = getPublicTelemetry();
    expect(t.accepted).toBe(2);
    expect(t.retained).toBe(1);
  });

  it("reads a payload written before these counters existed as zero", () => {
    localStorage.setItem(
      "palisade:completionTelemetry",
      JSON.stringify({ shown: 5, accepted: 2 })
    );
    const t = getPublicTelemetry();
    expect(t.shown).toBe(5);
    expect(t.abstained).toBe(0);
    expect(t.retained).toBe(0);
  });
});
