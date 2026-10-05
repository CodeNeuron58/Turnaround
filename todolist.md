# Turnaround — Build Checklist

> **Hacktoberfest Week 1 "Touch Grass"** · Deadline: **Mon Oct 12, 12:29 PM IST** · Target publish: **Sunday evening**
>
> Prize categories we're listing: **TabPFN · Temporal · Gemma · DigitalOcean**
> Used but not listed (plain code / open data — no other partner tech): Open-Meteo, OpenStreetMap/GPX, Piper, DB on the Droplet.
> Every box checked = ready to submit.

---

## 1. Project Setup

### Repository
- [ ] Create new **public** GitHub repo (must be started inside the challenge window)
- [ ] Add README (one-paragraph pitch: predicts hike time, tells you when to turn back, alerts your contact if you don't check in)
- [ ] Add open-source license
- [ ] Set up folder structure: `app/`, `prediction/`, `agent/`, `workflows/`, `data/`, `docs/`
- [ ] Add `.gitignore` + `.env.example` (email creds, DO API token, model paths — never commit secrets)
- [ ] Decide: solo entry (no team handles needed) — confirm before publishing

### Data
- [ ] Download the hikr.org dataset
- [ ] Export own past hikes (Strava / Garmin / any GPX files)
- [ ] Store both in `data/` with a short notes file on source and schema

### Accounts & access
- [ ] DigitalOcean account ready (GPU Droplet quota)
- [ ] Temporal available (cloud account or self-hosted)
- [ ] Email-sending account for escalation (SMTP or provider)
- [ ] DevRelay account (to save the agent session for the post)

---

## 2. Prediction Engine (TabPFN) — listed category

### Features & dataset
- [ ] Choose features: distance, climb, descent, highest point, difficulty
- [ ] Clean + normalize hikes into one training table
- [ ] Hold out a test set of hikes the model never sees

### Model + baseline
- [ ] Train TabPFN to predict hike duration **with a 90th-percentile estimate**
- [ ] Implement Naismith's rule as the baseline
- [ ] Evaluate both on the held-out set: average error per model
- [ ] Measure coverage: how often actual time landed inside the 90% estimate
- [ ] 📸 **Save the numbers** (TabPFN vs Naismith error, coverage %) — backbone of the post
- [ ] Wrap the model as a small HTTP prediction service (runs on the Droplet)

---

## 3. Infrastructure (DigitalOcean GPU Droplet) — listed category

- [ ] Create the GPU Droplet
- [ ] Install + run **Gemma 4** locally on it
- [ ] Deploy the **TabPFN prediction service** on it
- [ ] Set up the simple database on the same Droplet (trips, predicted vs actual)
- [ ] Set up **Piper** TTS (open-source) for briefing audio
- [ ] Basic firewall / auth so only the app talks to it
- [ ] Verify location data never leaves infra we control (note for "why open innovation" section)
- [ ] 📸 Screenshot the Droplet + services running (for the post)
- [ ] **Shut it down whenever idle — it bills while it exists**

---

## 4. Agent & Briefing (Gemma 4 — plain TypeScript, no framework)

### Agent abilities (all four required)
- [ ] Read a route (GPX / OpenStreetMap)
- [ ] Get weather + sunset (Open-Meteo)
- [ ] Call the TabPFN prediction
- [ ] Calculate turn-back time (90th percentile + sunset margin)

### Briefing
- [ ] Gemma 4 turns the numbers into a plain-language trip plan
- [ ] Briefing script reads like **advice from a friend, not a report** (review + tune until true)
- [ ] Piper generates the spoken audio version
- [ ] 📸 Save the agent session via DevRelay (embed in post — judges like it)

---

## 5. Safety Timer (Temporal) — listed category

### Workflow
- [ ] Trip workflow: **start → wait for "I'm out" or deadline → escalate**
- [ ] Escalation emails the contact: plan, route, expected return time
- [ ] Email sending **retries on failure**
- [ ] Workflow survives a worker restart (that's the point of Temporal — prove it)

### Tests — 📸 screenshot Temporal's event history for each
- [ ] Test 1: check in on time → trip closes cleanly
- [ ] Test 2: miss the check-in → escalation fires
- [ ] Test 3: kill the worker mid-trip → restart → workflow continues and still escalates

---

## 6. App

### Screens (3)
- [ ] **Plan** — pick or upload route, set start time, add emergency contact
- [ ] **On trail** — briefing text, safety-timer state, turn-back time, sunset margin
- [ ] **I'm out** — check in, close the trip, save actual time

### Offline + audio
- [ ] Piper briefing audio generated and playable offline
- [ ] Plan + one-screen text summary saved for offline use

### Feedback loop ("the next prediction improves")
- [ ] "I'm out" writes actual time to the Droplet DB
- [ ] Rerun prediction with the new data point → show before/after difference

### Stretch (only if ahead of schedule)
- [ ] Reminder notification before the turn-back time
- [ ] History page comparing predicted vs actual

---

## 7. Deployment & Verification

- [ ] Deploy everything on the Droplet (app, agent, Temporal worker, prediction, Piper, DB)
- [ ] Run **one full trip end to end**: plan → predict → brief → start → check in
- [ ] Draw the architecture diagram (one page, simple)
- [ ] README: how to run the whole stack

---

## 8. Real-World Test ("Touch Grass" — the theme itself)

- [ ] Do a **real hike** using the app: plan it → listen to briefing → start trip → check in at the end
- [ ] Note predicted vs actual time
- [ ] Take photos on the trail (for the post)
- [ ] Write down honest observations: what was useful, what was annoying
- [ ] Run one **missed-check-in drill** with a friend as contact → 📸 screenshot the alert they receive
- [ ] Record a **1–2 minute demo video**
- [ ] Add the real hike to the dataset → rerun prediction → show it adapting

---

## 9. Write-up & Submission (DEV post)

### Required content (submission template)
- [ ] What you built
- [ ] How it gets people **off the screen and into the world** (Touch Grass angle)
- [ ] Demo: video embed + live/repo link
- [ ] Code: GitHub repo link (embed)
- [ ] How you built it (use the saved numbers, screenshots, event histories)
- [ ] **Why open innovation matters** (runs offline, data stays on our own infra, model-swappable, zero cost)
- [ ] **Prize Categories section** — list exactly: TabPFN, Temporal, Gemma, DigitalOcean (opt-in = using it + listing it here)
- [ ] Tags: **#devchallenge #hf26challenge**
- [ ] Embed/link the DevRelay agent session

### Publish & share
- [ ] Proofread (writing quality is the heaviest-judged criterion)
- [ ] Publish **Sunday evening** (deadline is Mon Oct 12, 12:29 PM IST — don't cut it close)
- [ ] Share once in the MLH Discord + on socials
- [ ] Reply to every comment — reactions break ties
- [ ] Note any post-deadline commits in the repo README (required by rules)
