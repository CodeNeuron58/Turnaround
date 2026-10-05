# TabPFN vs Naismith's rule — 1,438 held-out hikr.org hikes

| Metric | Naismith's rule | TabPFN v2 | TabPFN v3.5 |
|---|---|---|---|
| Average error (MAE, min) | 44.1 | 35.5 | **34.8** |
| RMSE (min) | 69.1 | 56.2 | **54.5** |
| Actual time inside the 90% band (P5–P95) | — | 87.9% | **89.5%** |
| Finished before P90 (the turn-back alarm) | — | 89.7% | **90.4%** |
| Mean band width (min) | — | 140 | 151 |
| Model file | a formula | 42 MB | 835 MB |
| Eval runtime on CPU (s) | ~0 | 255 | 803 |

**Shipped model: TabPFN v3.5.** For a safety alarm, calibration matters more than
raw error, and v3.5's P90 is nearly perfect — 90.4% of hikers finish before it
(nominal: 90%). v2 results are kept for reference; both checkpoints load through
`TABPFN_MODEL_PATH` and are not committed.

Seed 42 · features: distance_km, climb_m, descent_m, highest_m, t_grade ·
target: recorded moving time (min) · data: `data/processed/hikes.csv` (7,186 hikes)
