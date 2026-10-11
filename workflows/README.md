# workflows

The Temporal safety timer — the promise the app makes to every hiker:

> "You started your trip. I will wait for your check-in until well past the
> moment you should be back. If that passes, I will tell your person where you
> set off, what your plan was, and when you were expected back — no matter what
> happens to this server. And if you check in after all, I'll tell them you're safe."

## Pieces

- `src/workflows.ts` — the trip workflow (deterministic: check-in signal vs a
  deadline timer; the service sets the deadline to the trip's alert moment —
  P95 + planned breaks + 30 min grace — overridable for drills and tests). A
  check-in after the alert sends the contact an all-clear.
- `src/activities.ts` — the alert and all-clear emails. **No mail provider wired
  yet**, so `deliver()` writes each email to `outbox/`; a provider swap replaces
  that one function. Alerts carry the hiker's name, trailhead and route-centre
  map links, sunset and rain; drill emails are marked `[DRILL]`. Simulated
  outage for the retry test: `FAIL_FIRST_N=2` in the worker's environment.
- `src/worker.ts` — the worker (kill it mid-trip; Temporal replays the workflow)
- `src/cli.ts` — start a trip's timer (pulls the trip from the prediction
  service) and send check-ins
- `scripts/kill-worker.ps1` — properly kills workers on Windows (TaskStop
  doesn't reliably kill npm's children)

## Local setup (free, no account)

```bash
tools/temporal/temporal.exe server start-dev --port 7233 --db-filename tools/temporal/turnaround.db
# binary: tools/README.md · --db-filename keeps timers across a server restart
cd workflows
npm run worker          # in one terminal
```

## Run the flow

The **service starts and signals timers itself**: `POST /trips/{id}/start` arms
`trip-<id>` (`?alert_in_sec=120` for a drill), `POST /trips/{id}/arm` retries a
timer that failed to arm, and `POST /trips/{id}/checkout` sends the check-in —
idempotently, so a phone retrying a queued check-in is safe. The response says
whether the timer got it (`checkin_signal`) and whether the alert had already
gone out (`alert_fired`). The CLI still works for tests:

```bash
# plan + start a trip in the prediction service first (it must be "active"), then:
npx tsx src/cli.ts start --trip 2 [--deadline 30]      # 30s override for tests
npx tsx src/cli.ts checkin --workflow trip-2           # "I'm out"
```

## Proof — five scenarios (evidence in `docs/evidence/`)

Scenarios 1–3 ran before the alert moved from P90 to P95 + breaks + grace and before alerts
carried a location; 4–5 use the current flow. `tests/smoke_stack.py` re-runs 1 and 4 on demand.

| Test | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Check in on time | `checked_in_on_time` | `test1_on_time.txt` |
| 2 | Miss check-in + email server fails once | retry (attempt 2) → `escalated` | `test2_escalation_retry.json`, `test2_alert_email.txt` |
| 3 | **Worker killed mid-trip**, restarted 25 s later | escalation fires exactly on the deadline | `test3_worker_restart.json`, `test3_alert_email.txt` |
| 4 | Drill: missed check-in, then a late check-in | alert on the deadline, then an all-clear → `escalated_late_checkin` | `test4_drill_history.json`, `test4_drill_alert_email.txt`, `test4_drill_allclear_email.txt` |
| 5 | **Temporal server killed mid-trip**, restarted on its `--db-filename` store | the timer is still `RUNNING` afterwards; check-in and arm failures during the outage are reported, then succeed on retry | `test5_temporal_server_restart.txt` |

Test 3's proof: workflow started at `…377596`, escalation email written at
`…468138` — **90.5 s later**, the full deadline, despite the worker being dead
from second 20 to 45. The promise didn't notice the outage.
