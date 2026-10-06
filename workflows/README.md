# workflows

The Temporal safety timer — the promise the app makes to every hiker:

> "You started your trip. I will wait for your check-in until the cautious
> estimate says you should be back. If that moment passes, I will tell your
> person where you are, what your plan was, and when you were expected back —
> no matter what happens to this server."

## Pieces

- `src/workflows.ts` — the trip workflow (deterministic: check-in signal vs a
  deadline timer; deadline = the P90 estimate, overridable for tests)
- `src/activities.ts` — the escalation email. **No SMTP account yet**, so
  delivery writes a full email to `outbox/` (swap to nodemailer later without
  touching the workflow). Simulated outage for the retry test: `FAIL_FIRST_N=2`
  in the worker's environment.
- `src/worker.ts` — the worker (kill it mid-trip; Temporal replays the workflow)
- `src/cli.ts` — start a trip's timer (pulls the trip from the prediction
  service) and send check-ins
- `scripts/kill-worker.ps1` — properly kills workers on Windows (TaskStop
  doesn't reliably kill npm's children)

## Local setup (free, no account)

```bash
tools/temporal/temporal.exe server start-dev --port 7233   # one-time binary, see cleanup.md
cd workflows
npm run worker          # in one terminal
```

## Run the flow

```bash
# plan + start a trip in the prediction service first (it must be "active"), then:
npx tsx src/cli.ts start --trip 2 [--deadline 30]      # 30s override for tests
npx tsx src/cli.ts checkin --workflow trip-2-<ts>      # "I'm out"
```

## Proof — all three scenarios (evidence in `docs/evidence/`)

| Test | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Check in on time | `checked_in_on_time` | `test1_on_time.txt` |
| 2 | Miss check-in + email server fails once | retry (attempt 2) → `escalated` | `test2_escalation_retry.json`, `test2_alert_email.txt` |
| 3 | **Worker killed mid-trip**, restarted 25 s later | escalation fires exactly on the deadline | `test3_worker_restart.json`, `test3_alert_email.txt` |

Test 3's proof: workflow started at `…377596`, escalation email written at
`…468138` — **90.5 s later**, the full deadline, despite the worker being dead
from second 20 to 45. The promise didn't notice the outage.
