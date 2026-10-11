"""The rules a trip is planned by: pure functions, no model, no I/O.

Used by the prediction service and the personal-hike importer, unit-tested in
prediction/tests/test_rules.py (stdlib only, so CI runs it without TabPFN).
agent/src/agent.ts mirrors turnaround_share() for the CLI.
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timedelta

# A personal hike only teaches the pace factor if it looks like a real hike —
# the same bounds build_dataset.py applies to the crowd. A three-minute test
# check-in must never tell the model you're fast.
MIN_TRAIN_MIN = 15.0
MAX_TRAIN_MIN = 20 * 60.0
# pseudo-hikes at factor 1.0: your first hike moves you a third of the way
PACE_SHRINK = 2.0
PACE_BOUNDS = (0.6, 1.8)
RATIO_BOUNDS = (0.4, 2.5)
# slack after the slow (P95) estimate, breaks included, before the contact is emailed
ALERT_GRACE_MIN = float(os.environ.get("ALERT_GRACE_MIN", "30"))


def pace_factor(ratios: list[float]) -> float:
    """Your pace relative to the crowd: the geometric mean of actual/crowd-median
    ratios, shrunk toward 1.0 by PACE_SHRINK pseudo-hikes and clamped, so one odd
    day can't swing the safety timer far in either direction."""
    if not ratios:
        return 1.0
    logs = [math.log(min(RATIO_BOUNDS[1], max(RATIO_BOUNDS[0], r))) for r in ratios]
    f = math.exp(sum(logs) / (len(logs) + PACE_SHRINK))
    return min(PACE_BOUNDS[1], max(PACE_BOUNDS[0], f))


def turnaround_share(distance_km: float, climb_m: float) -> float:
    """Share of the cautious trip time to spend heading out before turning
    around, assuming you retrace your steps from the far point. Naismith's
    split: 12 min per km each way, plus 1 min per 10 m of ascent, all of it on
    the way out. Clamped to 0.5-0.7 — flat routes split evenly, steep ones
    front-load the effort."""
    out = 6.0 * distance_km + 0.1 * climb_m
    back = 6.0 * distance_km
    return min(0.7, max(0.5, out / (out + back)))


def timeline(row) -> dict:
    """Minutes after the start for every moment a trip cares about, plus clock
    times once it has started. The model predicts time in motion; the clock
    doesn't stop for lunch, so planned breaks are added to every moment.

    turn_around  — not at the top / far end by now? head back
    back_by      — P90 + breaks: 9 in 10 similar hikes are done by now
    alert        — P95 + breaks + grace: the contact is emailed if no check-in

    `row` is anything indexable by column name (sqlite3.Row or dict).
    """
    breaks = row["breaks_min"] or 0.0
    back_by = row["p90_min"] + breaks
    if row["drill_alert_sec"]:
        alert = row["drill_alert_sec"] / 60
    else:
        alert = row["p95_min"] + breaks + ALERT_GRACE_MIN
    t = {
        "turn_around_after_min": round(turnaround_share(row["distance_km"], row["climb_m"]) * back_by, 1),
        "expected_back_after_min": round(row["expected_min"] + breaks, 1),
        "back_by_after_min": round(back_by, 1),
        "alert_after_min": round(alert, 2),
    }
    if row["started_at"]:
        start = datetime.fromisoformat(row["started_at"])
        for k in list(t):
            at = start + timedelta(minutes=t[k])
            t[k.replace("_after_min", "_at")] = at.isoformat(timespec="seconds")
    return t
