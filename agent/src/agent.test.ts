// Unit tests for the agent's turn-around rule — node's built-in test runner.
//   npm test -w @turnaround/agent

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTurnBack, turnaroundShare } from "./agent.ts";

test("turnaroundShare mirrors the service's rule", () => {
  assert.equal(turnaroundShare(10, 0), 0.5); // flat: half out, half back
  assert.ok(Math.abs(turnaroundShare(10, 300) - 0.6) < 1e-12);
  assert.equal(turnaroundShare(5, 3000), 0.7); // steep: capped
  // the same value prediction/tests/test_rules.py pins for turnaround_share()
  assert.ok(Math.abs(turnaroundShare(12.6, 1005) - 0.699642431466031) < 1e-12);
});

test("computeTurnBack: back by = start + P90 + breaks; turn around before it", () => {
  const sunsetLocal = "2026-10-10T18:00";
  const r = computeTurnBack(
    "2026-10-10T07:00",
    300,
    { sunset: sunsetLocal, sunsetEpochMs: new Date(sunsetLocal).getTime() },
    { distance_km: 10, climb_m: 300 },
    30,
  );
  assert.equal(r.backBy, "2026-10-10T12:30"); // 07:00 + 300 + 30 min
  assert.equal(r.turnAroundBy, "2026-10-10T10:18"); // 0.6 x 330 min = 198 min
  assert.equal(r.marginMin, 330); // 18:00 - 12:30
  assert.equal(r.afterDark, false);
  assert.equal(r.sunsetKnown, true);
});

test("computeTurnBack: back after sunset is flagged", () => {
  const sunsetLocal = "2026-10-10T12:00";
  const r = computeTurnBack(
    "2026-10-10T07:00",
    300,
    { sunset: sunsetLocal, sunsetEpochMs: new Date(sunsetLocal).getTime() },
    { distance_km: 10, climb_m: 300 },
  );
  assert.equal(r.marginMin, -30);
  assert.equal(r.afterDark, true);
});

test("computeTurnBack: unknown sunset is never treated as fine", () => {
  const r = computeTurnBack("2026-10-10T07:00", 300, { sunset: null, sunsetEpochMs: null }, { distance_km: 10, climb_m: 0 });
  assert.equal(r.sunsetKnown, false);
  assert.equal(r.marginMin, null);
  assert.equal(r.afterDark, false);
});

test("computeTurnBack rejects an unparseable start", () => {
  assert.throws(() => computeTurnBack("not a time", 300, { sunset: null, sunsetEpochMs: null }, { distance_km: 10, climb_m: 0 }));
});
