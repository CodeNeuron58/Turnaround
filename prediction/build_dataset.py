"""Build the training table for hike-time prediction.

Source: "GPS recorded hikes from hikr.org" (Kaggle: roccoli/gpx-hike-tracks) —
~12,000 GPX tracks scraped from hikr.org in spring 2018. Every feature we need
is precomputed in the CSV metadata, so the huge raw GPX column is never read.

Output: data/processed/hikes.csv (gitignored)
"""

from __future__ import annotations

import pathlib
import re

import pandas as pd

RAW = pathlib.Path("data/raw/gpx-tracks-from-hikr.org.csv")
OUT = pathlib.Path("data/processed/hikes.csv")

T_GRADE = re.compile(r"T([1-6])")

# Physical plausibility bounds — drop GPS junk without losing real hikes
MIN_DURATION_MIN = 15.0
MAX_DURATION_MIN = 20 * 60.0
MIN_DISTANCE_KM = 0.5
MAX_DISTANCE_KM = 50.0
MAX_CLIMB_M = 4500.0


def main() -> None:
    df = pd.read_csv(
        RAW,
        usecols=[
            "_id", "name", "url", "length_2d", "uphill", "downhill",
            "max_elevation", "difficulty", "moving_time",
        ],
    )
    print(f"raw rows: {len(df)}")

    df = df.dropna(subset=[
        "length_2d", "uphill", "downhill", "max_elevation",
        "difficulty", "moving_time",
    ])

    # Multi-GPX posts repeat the same trip URL; keep the longest track per trip
    df = df.sort_values("length_2d", ascending=False)
    df = df.drop_duplicates(subset="url", keep="first")

    df["t_grade"] = (
        df["difficulty"].astype(str).str.extract(T_GRADE).astype(float)
    )
    df = df.dropna(subset=["t_grade"])
    df["t_grade"] = df["t_grade"].astype(int)

    df["distance_km"] = df["length_2d"] / 1000.0
    df["duration_min"] = df["moving_time"] / 60.0

    df = df[
        (df["duration_min"] >= MIN_DURATION_MIN)
        & (df["duration_min"] <= MAX_DURATION_MIN)
        & (df["distance_km"] >= MIN_DISTANCE_KM)
        & (df["distance_km"] <= MAX_DISTANCE_KM)
        & (df["uphill"] >= 0)
        & (df["uphill"] <= MAX_CLIMB_M)
    ]

    out = df[[
        "_id", "name", "url", "distance_km", "uphill", "downhill",
        "max_elevation", "t_grade", "difficulty", "duration_min",
    ]].rename(columns={
        "_id": "track_id",
        "uphill": "climb_m",
        "downhill": "descent_m",
        "max_elevation": "highest_m",
    })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(OUT, index=False)

    print(f"kept rows: {len(out)}")
    print(out[["distance_km", "climb_m", "descent_m", "highest_m",
               "t_grade", "duration_min"]].describe().round(1))


if __name__ == "__main__":
    main()
