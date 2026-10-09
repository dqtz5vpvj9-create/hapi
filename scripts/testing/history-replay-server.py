#!/usr/bin/env python3
"""Read-only, loopback replay of privately captured HAPI history pages.

Capture files stay outside the repository. This server never forwards requests
and rejects mutations. --web-root selects a production build for comparison.
"""
import argparse
import json
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote


def position(row):
    return (row.get('invokedAt') or row['createdAt'], row['seq'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--web-root', type=Path, required=True)
    parser.add_argument('--port', type=int, default=5310)
    parser.add_argument('--latency-ms', type=int, default=80)
    args = parser.parse_args()
    captures = {}
    for path in args.data.iterdir():
        if path.suffix != '.json' or len(path.stem) != 36:
            continue
        capture = json.loads(path.read_text())
        pages = capture['pages']
        # Capturing an active session spans several requests. Replay is a
        # frozen transcript: later pages must not advertise a newer unseen tail
        # as if the offline client had missed live messages while scrolling.
        head = {key: pages[0]['page'][key] for key in ('snapshotHeadAt', 'snapshotHeadSeq')}
        for page in pages:
            page['page'] = {**page['page'], **head}
        rows = {row['id']: row for page in pages for row in page['messages']}
        capture['rows'] = sorted(rows.values(), key=position)
        capture['before'] = {
            (previous['page']['nextBeforeAt'], previous['page']['nextBeforeSeq']): page
            for previous, page in zip(pages, pages[1:])
        }
        captures[path.stem] = capture
    listed = json.loads((args.data / 'session-list.json').read_text())
    listed['sessions'] = [s for s in listed['sessions'] if s['id'] in captures]
    media = json.loads((args.data / 'media.json').read_text()) if (args.data / 'media.json').exists() else {}
    auxiliary = json.loads((args.data / 'aux.json').read_text()) if (args.data / 'aux.json').exists() else {}

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(args.web_root), **kw)

        def reply(self, value, status=200):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            if self.path == '/api/auth':
                self.reply({'token': 'local-history-replay', 'user': {'id': 1, 'firstName': 'Replay'}})
            elif self.path.startswith('/api/visibility'):
                self.reply({'ok': True})
            else:
                self.reply({'error': 'History replay is read-only'}, 405)
        do_PUT = do_POST
        do_DELETE = do_POST
        do_PATCH = do_POST

        def do_GET(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            if path in media:
                record = media[path]
                payload = (args.data / record['file']).read_bytes()
                time.sleep(args.latency_ms / 1000)
                self.send_response(200)
                self.send_header('Content-Type', record['type'])
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if path == '/__replay':
                return self.reply({'sessions': [{'id': id, 'messages': len(c['rows']), 'pages': len(c['pages'])} for id, c in captures.items()]})
            if not path.startswith('/api/'):
                if not Path(self.translate_path(path)).is_file() or path == '/index.html':
                    body = (args.web_root / 'index.html').read_text().replace('<head>', '<head><script>localStorage.setItem("hapi_access_token::","replay");localStorage.setItem("hapi_access_token::"+location.origin,"replay");localStorage.setItem("hapi-color-theme","codex");localStorage.setItem("hapi.fue.v1.rich-composer-mentions","1");</script>').encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                return super().do_GET()
            if path == '/api/events':
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                try:
                    self.wfile.write(b'data: {"type":"connection-changed","data":{"subscriptionId":"replay","resume":"ok"}}\n\n')
                    self.wfile.flush()
                    while True:
                        time.sleep(10)
                        self.wfile.write(b'data: {"type":"heartbeat"}\n\n')
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
            if path == '/api/sessions':
                return self.reply(listed)
            auxiliary_key = self.path if self.path in auxiliary else path
            if auxiliary_key in auxiliary:
                record = auxiliary[auxiliary_key]
                return self.reply(record['body'], record['status'])
            if path == '/api/machines':
                return self.reply({'machines': []})
            if path == '/api/hub-settings':
                return self.reply({'sessionSummaryInChat': False})
            parts = path.strip('/').split('/')
            if len(parts) < 3 or parts[1] != 'sessions' or parts[2] not in captures:
                return self.reply({'error': 'Not captured'}, 404)
            capture = captures[parts[2]]
            if len(parts) == 3:
                return self.reply(capture['session'])
            if parts[3:] == ['scratchlist']:
                return self.reply({'entries': []})
            if parts[3:] == ['messages', 'queued-state']:
                return self.reply({'messages': []})
            if len(parts) == 6 and parts[3] == 'messages' and parts[5] == 'context':
                rows = capture['rows']
                index = next((i for i, row in enumerate(rows) if row['id'] == parts[4]), None)
                if index is None:
                    return self.reply({'error': 'Outside captured history'}, 404)
                radius = int(query.get('radius', ['50'])[0])
                start, end = max(0, index - radius), min(len(rows), index + radius + 1)
                selected = rows[start:end]
                page = capture['pages'][0]['page']
                point = lambda row: {'at': position(row)[0], 'seq': row['seq']}
                head = {'at': page['snapshotHeadAt'], 'seq': page['snapshotHeadSeq']}
                return self.reply({'anchor': {'messageId': rows[index]['id'], 'position': point(rows[index])},
                    'messages': selected, 'page': {
                        'epoch': page['epoch'], 'reset': False,
                        'beforeCursor': point(selected[0]),
                        'afterCursor': head if end == len(rows) else point(selected[-1]),
                        'hasMoreBefore': start > 0, 'hasMoreAfter': end < len(rows), 'snapshotHead': head,
                    }})
            if parts[3:] != ['messages']:
                return self.reply({'error': 'Not captured'}, 404)
            time.sleep(args.latency_ms / 1000)
            rows = capture['rows']
            latest = capture['pages'][0]
            limit = int(query.get('limit', ['200'])[0])
            direction = 'before' if 'beforeSeq' in query else 'after' if 'afterSeq' in query else 'latest'
            cursor = lambda d: (int(query.get(d + 'At', ['0'])[0]), int(query[d + 'Seq'][0]))
            if direction == 'latest':
                return self.reply(latest)
            if direction == 'before' and cursor('before') in capture['before']:
                page = capture['before'][cursor('before')]
                if page is capture['pages'][-1]:
                    page = {**page, 'page': {**page['page'], 'hasMore': False}}
                return self.reply(page)
            eligible = [r for r in rows if (position(r) < cursor('before') if direction == 'before' else position(r) > cursor('after'))]
            selected = eligible[-limit:] if direction == 'before' else eligible[:limit]
            first = selected[0] if selected else None
            last = selected[-1] if selected else None
            reached_head = direction == 'after' and len(eligible) == len(selected)
            after = (latest['page']['snapshotHeadAt'], latest['page']['snapshotHeadSeq']) if reached_head else position(last) if last else (None, None)
            p = {**latest['page'], 'direction': direction, 'limit': limit, 'reset': False,
                 'nextBeforeAt': position(first)[0] if first else None, 'nextBeforeSeq': first['seq'] if first else None,
                 'nextAfterAt': after[0], 'nextAfterSeq': after[1],
                 'hasMore': len(eligible) > len(selected)}
            return self.reply({'messages': selected, 'page': p})

        def log_message(self, format, *values):
            # Request paths only; private message contents and credentials are never logged.
            print(format % values, flush=True)

    print(f'Replaying {len(captures)} sessions on 127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
