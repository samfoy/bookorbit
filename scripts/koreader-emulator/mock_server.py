#!/usr/bin/env python3
"""Deterministic BookOrbit API fixture for KOReader emulator UI checks."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BOOKS = [
    {
        "id": "hardcover:101",
        "title": "The Glass Archive",
        "authors": ["Mara Venn"],
        "coverUrl": None,
        "description": "A historian discovers a library whose books remember their readers.",
        "publishedYear": 2026,
        "rating": 4.4,
        "ratingsCount": 1820,
        "isbn10": None,
        "isbn13": "9780000000101",
        "pageCount": 352,
        "seriesName": "Archive Cycle",
        "seriesPosition": 1,
        "hasEbook": True,
        "genres": [{"name": "Fantasy", "slug": "fantasy"}],
        "sources": [{"source": "hardcover", "externalId": "101", "url": "https://hardcover.app/books/the-glass-archive"}],
    },
    {
        "id": "hardcover:102",
        "title": "Orbital Winter",
        "authors": ["Ishaan Cole"],
        "coverUrl": None,
        "description": "A stranded crew races the dark side of a failing moon.",
        "publishedYear": 2025,
        "rating": 4.2,
        "ratingsCount": 991,
        "isbn10": None,
        "isbn13": "9780000000102",
        "pageCount": 416,
        "seriesName": None,
        "seriesPosition": None,
        "hasEbook": True,
        "genres": [{"name": "Science Fiction", "slug": "science-fiction"}],
        "sources": [{"source": "hardcover", "externalId": "102", "url": "https://hardcover.app/books/orbital-winter"}],
    },
    {
        "id": "storygraph:103",
        "title": "A Map of Quiet Rivers",
        "authors": ["Nora Bell"],
        "coverUrl": None,
        "description": "A lyrical mystery set across a disappearing watershed.",
        "publishedYear": 2024,
        "rating": 4.1,
        "ratingsCount": 744,
        "isbn10": None,
        "isbn13": "9780000000103",
        "pageCount": 288,
        "seriesName": None,
        "seriesPosition": None,
        "hasEbook": True,
        "genres": [{"name": "Mystery", "slug": "mystery"}],
        "sources": [{"source": "storygraph", "externalId": "103", "url": "https://app.thestorygraph.com/books/103"}],
    },
]


def section(section_id: str, title: str, kind: str, value: str | None, items: list[dict]) -> dict:
    return {"id": section_id, "title": title, "subtitle": None, "kind": kind, "value": value, "items": items}


class Handler(BaseHTTPRequestHandler):
    server_version = "BookOrbitEmulatorFixture/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(fmt % args, flush=True)

    def send_json(self, body: object, status: int = 200) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path.endswith("/koreader/plugin/version"):
            self.send_json({"pluginVersion": "1.6.0", "serverVersion": "emulator", "capabilities": ["catalogStore"]})
        elif path.endswith("/koreader/plugin/catalog/dashboard"):
            self.send_json(
                {
                    "generatedAt": "2026-08-31T00:00:00.000Z",
                    "username": "emulator",
                    "displayName": "Emulator",
                    "totalBooks": 0,
                    "browseCounts": {},
                    "sections": [],
                    "continueReading": [],
                    "discover": [],
                    "readingGoal": {"goalBooks": 100, "completedBooks": 42},
                    "readingStreak": {"currentStreak": 7},
                    "highlightOfTheDay": None,
                }
            )
        elif path.endswith("/koreader/plugin/catalog/store/home"):
            self.send_json(
                {
                    "generatedAt": "2026-08-31T00:00:00.000Z",
                    "trending": section("trending", "Trending this week", "trending", None, BOOKS),
                    "genreShelves": [section("genre-fantasy", "Fantasy", "genre", "fantasy", BOOKS[:2])],
                    "genres": [
                        {"name": "Fantasy", "slug": "fantasy"},
                        {"name": "Science Fiction", "slug": "science-fiction"},
                        {"name": "Mystery", "slug": "mystery"},
                    ],
                }
            )
        elif path.endswith("/koreader/plugin/catalog/store/browse"):
            page = int(query.get("page", ["1"])[0])
            kind = query.get("kind", ["trending"])[0]
            value = query.get("value", [None])[0]
            self.send_json({**section(f"{kind}-{value or 'all'}", f"{kind.title()} books", kind, value, BOOKS), "page": page, "pageSize": 12, "hasMore": False})
        elif path.endswith("/koreader/plugin/catalog/store/search"):
            self.send_json(
                {
                    "results": BOOKS,
                    "sources": [
                        {"source": "hardcover", "configured": True, "available": True, "resultCount": 2, "message": None},
                        {"source": "storygraph", "configured": True, "available": True, "resultCount": 1, "message": None},
                    ],
                }
            )
        elif path.endswith("/koreader/plugin/catalog/store/config"):
            self.send_json(
                {
                    "canAcquire": True,
                    "sources": [{"source": "libgen", "available": True, "label": "LibGen", "message": None}],
                    "libraries": [{"id": 1, "name": "Ebooks", "folders": [{"id": 1, "path": "/books"}]}],
                }
            )
        elif path.endswith("/koreader/plugin/catalog/store/acquisitions"):
            self.send_json([])
        elif path.endswith("/koreader/plugin/catalog/root"):
            self.send_json({"sections": []})
        else:
            self.send_json({"message": f"No fixture for {path}"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.endswith("/koreader/plugin/match-check"):
            self.send_json({"matches": [], "libraryVersion": "emulator-v1"})
        elif self.path.endswith("/koreader/plugin/catalog/store/acquisitions"):
            self.send_json(
                {
                    "id": "00000000-0000-4000-8000-000000000001",
                    "title": "The Glass Archive",
                    "author": "Mara Venn",
                    "status": "downloading",
                    "source": "libgen",
                    "libraryId": 1,
                    "bookId": None,
                    "bytesDownloaded": None,
                    "x3Optimized": None,
                    "error": None,
                    "createdAt": "2026-08-31T00:00:00.000Z",
                    "updatedAt": "2026-08-31T00:00:00.000Z",
                },
                202,
            )
        else:
            self.send_json({"message": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 18080), Handler).serve_forever()
