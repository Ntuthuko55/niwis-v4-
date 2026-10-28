"""Bounded cache of immutable JSON responses, shared by all monitoring routes.

Avoid repeating pandas aggregation, defensive DataFrame copies, and JSON encoding
when a chart/map is reopened. Requests with credentials, errors, and oversized
responses bypass storage. Cache metadata describes retrieval time, not the date
of the underlying observations.
"""
import asyncio
import json
import os
from collections import OrderedDict
from datetime import datetime, timezone
from time import monotonic
from urllib.parse import parse_qsl

PREFIXES = ('/climate/', '/vegetation/', '/rainfall/', '/runoff/', '/surface-water/',
            '/groundwater/', '/groundwater-reserve/', '/water-quality/', '/wastewater/', '/drinking-water/',
            '/rwqo/', '/wrm/', '/water-quantity/', '/reservoirs/', '/drought-monitoring/', '/meteorological/', '/hydrology/', '/satellite/')


def _has_source_error(body):
    """Do not retain HTTP 200 dashboard payloads that report source failures."""
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False
    if isinstance(payload.get('errors'), dict) and payload['errors']:
        return True
    sources = payload.get('sources')
    return isinstance(sources, dict) and any(
        isinstance(source, dict) and source.get('status') == 'error'
        for source in sources.values()
    )


class DashboardResponseCache:
    def __init__(self, app, ttl=None, max_bytes=32 * 1024 * 1024, max_response_bytes=2 * 1024 * 1024):
        self.app = app
        default_ttl = os.getenv('NIWIS_DASHBOARD_CACHE_TTL', '86400')
        self.ttl = max(0, int(os.getenv('NIWIS_RESPONSE_CACHE_TTL', default_ttl))) if ttl is None else ttl
        self.max_bytes = max_bytes
        self.max_response_bytes = max_response_bytes
        self.entries = OrderedDict()
        self.inflight = {}
        self.size = 0

    async def __call__(self, scope, receive, send):
        headers = dict(scope.get('headers', []))
        path = scope.get('path', '')
        if (scope['type'] != 'http' or scope.get('method') != 'GET' or not self.ttl
                or not path.startswith(PREFIXES) or path.endswith('/audit')
                or b'authorization' in headers or b'cookie' in headers):
            return await self.app(scope, receive, send)
        query = tuple(sorted(parse_qsl(scope.get('query_string', b'').decode('utf-8'), keep_blank_values=True)))
        key = (path, query, headers.get(b'origin', b''))
        bypass = b'no-cache' in headers.get(b'cache-control', b'')
        while True:
            entry = self.entries.get(key)
            if entry and entry[0] > monotonic() and not bypass:
                self.entries.move_to_end(key)
                _, start, body, cached_at = entry
                await send({**start, 'headers': [*start['headers'], (b'x-niwis-cache', b'HIT'),
                            (b'x-niwis-cached-at', cached_at)]})
                await send({'type': 'http.response.body', 'body': body})
                return
            if entry:
                self.size -= len(entry[2])
                del self.entries[key]
            pending = self.inflight.get(key)
            if pending is None:
                event = asyncio.Event()
                self.inflight[key] = event
                break
            await pending.wait()
            # Failed/uncacheable responses are not reused by subsequent callers.

        start = None
        chunks = []
        total = 0
        complete = False
        cached_at = datetime.now(timezone.utc).isoformat().encode()

        async def capture(message):
            nonlocal start, total, complete
            if message['type'] == 'http.response.start':
                start = {**message, 'headers': list(message.get('headers', []))}
                message = {**start, 'headers': [*start['headers'], (b'x-niwis-cache', b'MISS'),
                           (b'x-niwis-cached-at', cached_at)]}
            elif message['type'] == 'http.response.body':
                total += len(message.get('body', b''))
                if total <= self.max_response_bytes:
                    chunks.append(message.get('body', b''))
                else:
                    chunks.clear()
                complete = not message.get('more_body', False)
            await send(message)

        try:
            await self.app(scope, receive, capture)
            response_headers = dict(start['headers']) if start else {}
            if (start and start['status'] == 200 and complete and total <= self.max_response_bytes
                    and b'application/json' in response_headers.get(b'content-type', b'')
                    and b'set-cookie' not in response_headers
                    and b'no-store' not in response_headers.get(b'cache-control', b'')
                    and not _has_source_error(b''.join(chunks))):
                body = b''.join(chunks)
                while self.entries and (self.size + len(body) > self.max_bytes or len(self.entries) >= 128):
                    _, old = self.entries.popitem(last=False)
                    self.size -= len(old[2])
                if len(body) <= self.max_bytes:
                    self.entries[key] = (monotonic() + self.ttl, start, body, cached_at)
                    self.size += len(body)
        finally:
            self.inflight.pop(key, None)
            event.set()
