# workflows

The Temporal safety timer — the reason a missed check-in still escalates if the server restarts.

A trip workflow:

1. Starts when you head out
2. Waits for "I'm out" — or until the predicted worst-case return time
3. Escalates to the emergency contact: the plan, the route, and the expected return time
4. Retries email delivery on failure, and survives a worker restart mid-trip
