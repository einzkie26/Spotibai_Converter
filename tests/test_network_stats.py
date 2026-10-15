import unittest
from types import SimpleNamespace
from unittest.mock import patch

import app


class NetworkStatsTests(unittest.TestCase):
    def test_timed_computer_counters_are_returned_without_caching(self):
        counters = SimpleNamespace(bytes_sent=123, bytes_recv=4567, dropin=2, dropout=3, errin=4, errout=5)
        with patch.object(app.psutil, "net_io_counters", return_value=counters) as read, \
             patch.object(app.time, "monotonic", return_value=12.5), app.app.test_client() as client:
            response = client.get("/net-stats")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"bytes_sent": 123, "bytes_recv": 4567,
                                        "packet_loss": 5, "buffer_overflow": 9,
                                        "sampled_at": 12.5, "scope": "computer"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        read.assert_called_once_with()

    def test_missing_or_failed_counters_report_unavailability_instead_of_zeros(self):
        for settings in ({"return_value": None}, {"side_effect": OSError("Counters failed")}):
            with self.subTest(settings=settings), patch.object(app.psutil, "net_io_counters", **settings), app.app.test_client() as client:
                response = client.get("/net-stats")
            self.assertEqual(response.status_code, 503)
            self.assertIn("unavailable", response.json["error"])
            self.assertNotIn("bytes_recv", response.json)
