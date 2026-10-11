"""End-to-end smoke test against a running stack (service + Temporal + worker).

    # a scratch database, so test hikes never touch your pace factor
    set TURNAROUND_DB=%TEMP%\\turnaround-smoke.db      (then start the service)
    set OUTBOX_DIR=%TEMP%\\turnaround-outbox           (then start the worker)
    .venv\\Scripts\\python.exe tests\\smoke_stack.py [--briefing] [--outbox DIR]

Scenarios: plan -> start -> check in (signal delivered, nobody alerted, pace
factor learns); a repeated check-in is idempotent; a 5-minute check-in never
trains; the drill (alert fires on the deadline, late check-in, all-clear).
--briefing also exercises Gemma + Piper (needs Ollama; 1-3 min on CPU).
Refuses to run against data/trips.db.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
GPX = (ROOT / "data" / "test-route.gpx").read_bytes()
fails: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        fails.append(label)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", default=os.environ.get("PREDICTION_SERVICE_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--outbox", default=os.environ.get("OUTBOX_DIR", str(ROOT / "workflows" / "outbox")))
    ap.add_argument("--briefing", action="store_true", help="also test Gemma briefing + Piper audio")
    args = ap.parse_args()
    B, outbox = args.service, pathlib.Path(args.outbox)

    health = requests.get(f"{B}/health", timeout=10).json()
    if pathlib.Path(health["db"]).resolve() == (ROOT / "data" / "trips.db").resolve():
        sys.exit("refusing to run: the service is using data/trips.db — start it with TURNAROUND_DB pointing at a scratch file")
    if health["status"] != "ready":
        sys.exit(f"service not ready: {health}")

    def post(path, **kw):
        return requests.post(B + path, timeout=300, **kw)

    def plan(name):
        route = post("/route/analyze?t_grade=3", data=GPX, headers={"Content-Type": "application/gpx+xml"}).json()
        now = datetime.now(timezone.utc)
        body = {**{k: route[k] for k in ("distance_km", "climb_m", "descent_m", "highest_m")}, "t_grade": 3,
                "name": name, "contact_email": "friend@example.com", "hiker_name": "Biprayan", "breaks_min": 30,
                "lat": route["lat"], "lon": route["lon"], "start_lat": route["start_lat"], "start_lon": route["start_lon"],
                "sunset_at": (now + timedelta(hours=8)).isoformat(), "rain_pct": 20, "planned_start": now.isoformat()}
        r = post("/trips", json=body)
        assert r.status_code == 201, r.text
        return route, r.json()

    print("1. plan -> start -> check in")
    pace0 = health["pace_factor"], health["pace_hikes"]
    route, t = plan("Smoke: on time")
    check(route["start_lat"] is not None, "route analysis returns the trailhead")
    check(t["back_by_after_min"] == round(t["p90_min"] + 30, 1), "back-by = P90 + breaks")
    check(t["turn_around_after_min"] < t["back_by_after_min"] < t["alert_after_min"], "turn-around < back-by < alert")
    if args.briefing:
        t0 = time.time()
        b = post(f"/trips/{t['id']}/briefing")
        check(b.status_code == 200 and len(b.json().get("briefing", "")) > 40, f"Gemma briefing ({time.time() - t0:.0f}s)")
        check(post(f"/trips/{t['id']}/briefing").json() == b.json(), "briefing is stored, not regenerated")
        a = post(f"/trips/{t['id']}/briefing/audio")
        check(a.status_code == 200 and a.content[:4] == b"RIFF", f"Piper wav ({len(a.content) // 1024} KB)")
    s = post(f"/trips/{t['id']}/start").json()
    check(s["timer_status"] == "armed", "start arms the safety timer")
    actual = round(t["crowd_min"] * t["pace_factor"] * 1.4 + 30, 1)  # 1.4x slower than predicted, plus breaks
    c = post(f"/trips/{t['id']}/checkout", json={"actual_min": actual}).json()
    check(c["checkin_signal"] == "delivered" and not c["alert_fired"], "check-in reaches the timer; nobody alerted")
    check(c["trained"] and c["your_pace_hikes"] == pace0[1] + 1, "the hike trains the pace factor")
    check(c["your_pace_factor"] > pace0[0], f"pace factor moves: x{pace0[0]} -> x{c['your_pace_factor']}")
    time.sleep(2)
    c2 = post(f"/trips/{t['id']}/checkout", json={"actual_min": actual}).json()
    check(c2["already_checked_out"] and c2["checkin_signal"] == "delivered", "repeated check-in is idempotent, still 'delivered'")
    check(c2["your_pace_hikes"] == c["your_pace_hikes"], "repeat adds no training row")

    print("2. a 5-minute check-in never trains")
    _, t = plan("Smoke: too short")
    post(f"/trips/{t['id']}/start")
    c = post(f"/trips/{t['id']}/checkout", json={"actual_min": 5}).json()
    check(not c["trained"], "too short to learn from")

    print("3. drill: alert on the deadline -> late check-in -> all-clear")
    _, t = plan("Smoke: drill")
    s = post(f"/trips/{t['id']}/start?alert_in_sec=30").json()
    check(s["drill"] and s["timer_status"] == "armed", "drill armed: alert 30 s after start")
    alert = outbox / f"escalation-trip-{t['id']}.txt"
    for _ in range(90):
        if alert.exists():
            break
        time.sleep(1)
    check(alert.exists(), f"alert email delivered ({alert.name})")
    if alert.exists():
        body = alert.read_text(encoding="utf-8")
        check("[DRILL]" in body and "Biprayan is overdue" in body and "openstreetmap.org" in body,
              "alert: marked as a drill, names the hiker, links the trailhead map")
    c = post(f"/trips/{t['id']}/checkout", json={"actual_min": 1}).json()
    check(c["alert_fired"] and c["checkin_signal"] == "delivered", "late check-in: alert had fired, signal delivered")
    clear = outbox / f"allclear-trip-{t['id']}.txt"
    for _ in range(60):
        if clear.exists():
            break
        time.sleep(1)
    check(clear.exists(), f"all-clear email delivered ({clear.name})")

    print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
