"""Fold your own past hikes into your pace factor.

    .venv\\Scripts\\python.exe prediction/import_hikes.py --grade 3 [files or folders ...]

With no paths it reads data/raw/gpx/. Each GPX needs timestamps — any recording
app's export (Strava, Garmin, Komoot) has them. For every file: the route's
features measured exactly as /route/analyze does, moving time from the track
itself (gpxpy's moving-time rule, the same one behind the hikr.org dataset),
and the crowd model's median for that route. The ratio between the last two is
what a finished trip adds at check-out. The grade applies to the whole run, so
import T2 hikes and T3 hikes separately. Re-running skips files already imported.

Stop the prediction service first or not — both share trips.db safely (WAL).
"""

from __future__ import annotations

import argparse
import pathlib
import sys
from contextlib import closing

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import gpxpy  # noqa: E402

from prediction.service import (  # noqa: E402
    MAX_TRAIN_MIN, MIN_TRAIN_MIN, db, fit_model, init_schema, now_iso,
    predict_quantiles, route_features, your_pace,
)


def gpx_files(paths: list[str]) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for p in map(pathlib.Path, paths or [str(ROOT / "data" / "raw" / "gpx")]):
        if p.is_dir():
            out += sorted(p.glob("*.gpx"))
        elif p.exists():
            out.append(p)
        else:
            print(f"skip  {p}: not found")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="*", help="GPX files or folders (default: data/raw/gpx)")
    ap.add_argument("--grade", type=int, required=True, choices=range(1, 7), help="SAC grade T1-T6 for these hikes")
    args = ap.parse_args()

    files = gpx_files(args.paths)
    if not files:
        sys.exit("no GPX files found")
    init_schema()
    print("fitting the crowd model (first predict pays torch's warm-up, ~1-2 min)...")
    fit_model()
    before, _ = your_pace()

    added = 0
    for f in files:
        source = f"gpx:{f.name}"
        with closing(db()) as conn:
            if conn.execute("SELECT 1 FROM personal_hikes WHERE source=?", (source,)).fetchone():
                print(f"skip  {f.name}: already imported")
                continue
        try:
            gpx = gpxpy.parse(f.read_text(encoding="utf-8", errors="replace"))
            feats = route_features(gpx)
        except Exception as e:
            print(f"skip  {f.name}: {e}")
            continue
        moving_min = gpx.get_moving_data().moving_time / 60
        if moving_min <= 0:
            print(f"skip  {f.name}: no timestamps, so no moving time")
            continue
        if not MIN_TRAIN_MIN <= moving_min <= MAX_TRAIN_MIN:
            print(f"skip  {f.name}: {moving_min:.0f} min moving is outside {MIN_TRAIN_MIN:.0f}-{MAX_TRAIN_MIN:.0f}")
            continue
        model_feats = {k: feats[k] for k in ("distance_km", "climb_m", "descent_m", "highest_m")}
        model_feats["t_grade"] = args.grade
        try:
            crowd = predict_quantiles(model_feats)["expected_min"]
        except Exception as e:  # e.g. a route outside the model's training range
            print(f"skip  {f.name}: {getattr(e, 'detail', e)}")
            continue
        with closing(db()) as conn:
            conn.execute(
                "INSERT INTO personal_hikes(distance_km, climb_m, descent_m, highest_m,"
                " t_grade, duration_min, crowd_min, source, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (*model_feats.values(), moving_min, crowd, source, now_iso()),
            )
            conn.commit()
        added += 1
        print(f"added {f.name}: {feats['distance_km']:.1f} km, {feats['climb_m']:.0f} m up — "
              f"{moving_min:.0f} min moving vs crowd {crowd:.0f} min (x{moving_min / crowd:.2f})")

    after, n = your_pace()
    print(f"\n{added} hike(s) added. Pace factor x{before:.3f} -> x{after:.3f} from {n} personal hike(s).")


if __name__ == "__main__":
    main()
