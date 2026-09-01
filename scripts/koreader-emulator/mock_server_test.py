#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mock_server import Handler


class MockServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post_json(self, path: str, body: object) -> tuple[int, object]:
        request = Request(
            f"http://127.0.0.1:{self.server.server_port}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request) as response:
            return response.status, json.load(response)

    def test_match_check_is_a_harmless_startup_no_op(self) -> None:
        status, body = self.post_json(
            "/api/v1/koreader/plugin/match-check",
            {"hashes": [], "candidates": [], "deviceId": "emulator"},
        )

        self.assertEqual(status, 200)
        self.assertEqual(body, {"matches": [], "libraryVersion": "emulator-v1"})


if __name__ == "__main__":
    unittest.main()
