# Data notes

## Source

**"GPS recorded hikes from hikr.org"** — Kaggle dataset [`roccoli/gpx-hike-tracks`](https://www.kaggle.com/datasets/roccoli/gpx-hike-tracks):
~12,000 GPX tracks and metadata of mountain hikes, scraped from hikr.org in spring 2018.
See the Kaggle page for the dataset license. The file lives in `data/raw/` (gitignored).

## Output schema (`data/processed/hikes.csv`, gitignored)

Produced by `prediction/build_dataset.py`. One row = one hike track.

| Column | Meaning |
|---|---|
| `track_id`, `name`, `url` | provenance back to the hikr.org post |
| `distance_km` | 2D track length |
| `climb_m` | total ascent (uphill) |
| `descent_m` | total descent (downhill) |
| `highest_m` | max elevation |
| `t_grade` | SAC hiking scale extracted from `difficulty` (T1–T6 as 1–6) |
| `difficulty` | raw difficulty string |
| `duration_min` | **target** — recorded moving time in minutes |

## Cleaning rules

- rows missing any feature or the target are dropped
- multi-GPX posts (same trip URL) keep only the longest track
- `duration_min` limited to 15 min – 20 h, `distance_km` to 0.5–50 km, `climb_m` to 0–4500 m
- only hikes with a parseable T1–T6 grade are kept

## Personal hikes

Own GPX exports (Strava / Garmin) can be added to `data/raw/gpx/` later — they feed the
"the app adapts to you" part of the project.
