"""Small in-process GET probe for verification without an HTTP test dependency."""
import asyncio
import json
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass
class ProbeResponse:
    status_code: int
    headers: dict
    body: bytes

    def json(self):
        return json.loads(self.body)


async def get_json(app, path):
    url = urlsplit(path)
    messages = []
    received = False

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Event().wait()

    async def send(message):
        messages.append(message)

    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
               "scheme": "http", "path": url.path, "raw_path": url.path.encode(), "root_path": "",
               "query_string": url.query.encode(), "headers": [], "server": ("test", 80), "client": ("test", 1)}, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return ProbeResponse(start["status"], {key.decode(): value.decode() for key, value in start["headers"]}, body)
