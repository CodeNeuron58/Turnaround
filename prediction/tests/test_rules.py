"""Unit tests for the trip rules — stdlib only, no model needed.

    python -m unittest discover -s prediction/tests -t .
"""

import math
import unittest
from datetime import datetime

from prediction.rules import ALERT_GRACE_MIN, pace_factor, timeline, turnaround_share


def trip(**kw):
    row = dict(
        distance_km=12.6, climb_m=1005.0, p90_min=311.0, p95_min=322.0, expected_min=269.0,
        breaks_min=30.0, drill_alert_sec=None, started_at=None,
    )
    row.update(kw)
    return row


class PaceFactor(unittest.TestCase):
    def test_no_history_is_the_crowd(self):
        self.assertEqual(pace_factor([]), 1.0)

    def test_one_hike_moves_a_third_of_the_way_in_log_space(self):
        self.assertAlmostEqual(pace_factor([1.4]), 1.4 ** (1 / 3))
        self.assertAlmostEqual(pace_factor([0.7]), 0.7 ** (1 / 3))

    def test_more_history_trusts_you_more(self):
        one, three, ten = pace_factor([1.4]), pace_factor([1.4] * 3), pace_factor([1.4] * 10)
        self.assertLess(one, three)
        self.assertLess(three, ten)
        self.assertLess(ten, 1.4)

    def test_a_wild_ratio_is_clamped_before_it_counts(self):
        self.assertAlmostEqual(pace_factor([10.0]), 2.5 ** (1 / 3))
        self.assertAlmostEqual(pace_factor([0.01]), 0.4 ** (1 / 3))

    def test_the_factor_itself_is_bounded(self):
        self.assertEqual(pace_factor([2.5] * 100), 1.8)
        self.assertEqual(pace_factor([0.4] * 100), 0.6)

    def test_geometric_not_arithmetic(self):
        # twice as fast once and twice as slow once cancel out
        self.assertAlmostEqual(pace_factor([2.0, 0.5]), 1.0)


class TurnaroundShare(unittest.TestCase):
    def test_flat_route_turns_at_half(self):
        self.assertEqual(turnaround_share(10, 0), 0.5)

    def test_climbing_front_loads_the_effort(self):
        self.assertTrue(math.isclose(turnaround_share(10, 300), 0.6))

    def test_steep_route_is_capped(self):
        self.assertEqual(turnaround_share(5, 3000), 0.7)

    def test_value_pinned_for_the_typescript_mirror(self):
        # agent/src/agent.test.ts pins the same number for turnaroundShare()
        self.assertAlmostEqual(turnaround_share(12.6, 1005), 0.699642431466031)


class Timeline(unittest.TestCase):
    def test_breaks_are_added_to_every_moment(self):
        t = timeline(trip())
        self.assertEqual(t["expected_back_after_min"], 299.0)
        self.assertEqual(t["back_by_after_min"], 341.0)
        self.assertEqual(t["alert_after_min"], round(322.0 + 30 + ALERT_GRACE_MIN, 2))

    def test_order_turn_around_then_back_by_then_alert(self):
        t = timeline(trip())
        self.assertLess(t["turn_around_after_min"], t["back_by_after_min"])
        self.assertLess(t["back_by_after_min"], t["alert_after_min"])

    def test_turn_around_is_the_outbound_share_of_back_by(self):
        t = timeline(trip())
        self.assertAlmostEqual(t["turn_around_after_min"], round(turnaround_share(12.6, 1005) * 341.0, 1))

    def test_no_breaks(self):
        t = timeline(trip(breaks_min=0))
        self.assertEqual(t["back_by_after_min"], 311.0)

    def test_drill_overrides_only_the_alert(self):
        t = timeline(trip(drill_alert_sec=90))
        self.assertEqual(t["alert_after_min"], 1.5)
        self.assertEqual(t["back_by_after_min"], 341.0)

    def test_clock_times_appear_once_started(self):
        self.assertNotIn("alert_at", timeline(trip()))
        t = timeline(trip(started_at="2026-10-10T02:00:00+00:00"))
        self.assertEqual(t["back_by_at"], "2026-10-10T07:41:00+00:00")
        self.assertEqual(datetime.fromisoformat(t["alert_at"]).utcoffset().total_seconds(), 0)


if __name__ == "__main__":
    unittest.main()
