#!/usr/bin/env python3
"""dns-dot-co webapp: probe .co TLD nameservers + resolvers every minute,
persist to sqlite, serve a dashboard. Stdlib only.

Run:
  ./app.py                 # starts probing + serves on http://127.0.0.1:8765
  ./app.py --port 9000
  ./app.py --interval 30   # seconds between runs
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DB_PATH = Path(__file__).parent / "probes.db"

TLD_NS = ["a.registrydns.co", "b.registrydns.co", "c.registrydns.co", "d.registrydns.co"]
SAMPLE_DOMAINS = ["daily.co", "huggingface.co", "hinge.co", "go.co"]
PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]
ATT_RESOLVERS = [
    "68.94.156.1", "68.94.157.1",
    "205.152.37.23", "205.152.144.23", "205.152.144.24", "205.152.132.23",
]
CONTROL_DOMAIN = "example.com"
TIMEOUT = 3


def local_resolvers() -> list[str]:
    try:
        text = Path("/etc/resolv.conf").read_text()
    except OSError:
        return []
    return [l.split()[1] for l in text.splitlines()
            if l.startswith("nameserver") and len(l.split()) >= 2]


def init_db() -> None:
    with sqlite3.connect(DB_PATH) as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS probes (
            id        INTEGER PRIMARY KEY,
            ts        TEXT    NOT NULL,
            run_id    INTEGER NOT NULL,
            kind      TEXT    NOT NULL,
            server    TEXT    NOT NULL,
            domain    TEXT    NOT NULL,
            ok        INTEGER NOT NULL,
            ms        INTEGER,
            ns_count  INTEGER,
            error     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_probes_ts ON probes(ts);
        CREATE INDEX IF NOT EXISTS idx_probes_run ON probes(run_id);
        CREATE INDEX IF NOT EXISTS idx_probes_server ON probes(server, domain, ts);
        """)


_STATUS_RE = re.compile(r"status:\s*([A-Z]+)")


def probe(server: str, domain: str) -> dict:
    start = time.monotonic()
    try:
        result = subprocess.run(
            ["dig", f"+tries=1", f"+time={TIMEOUT}",
             "+noall", "+answer", "+authority", "+comments",
             f"@{server}", domain, "NS"],
            capture_output=True, text=True, timeout=TIMEOUT + 2,
        )
        out = result.stdout + result.stderr
        ms = int((time.monotonic() - start) * 1000)
        if result.returncode != 0:
            return {"ok": 0, "ms": ms, "ns_count": None, "error": f"exit={result.returncode}"}
        if "connection timed out" in out:
            return {"ok": 0, "ms": ms, "ns_count": None, "error": "timeout"}
        m = _STATUS_RE.search(out)
        rcode = m.group(1) if m else ""
        if rcode and rcode != "NOERROR":
            return {"ok": 0, "ms": ms, "ns_count": None, "error": f"rcode={rcode}"}
        ns_pat = re.compile(rf"^{re.escape(domain)}\.\s+\d+\s+IN\s+NS", re.MULTILINE)
        return {"ok": 1, "ms": ms, "ns_count": len(ns_pat.findall(out)), "error": None}
    except subprocess.TimeoutExpired:
        return {"ok": 0, "ms": int((time.monotonic() - start) * 1000),
                "ns_count": None, "error": "subprocess timeout"}
    except Exception as e:
        return {"ok": 0, "ms": int((time.monotonic() - start) * 1000),
                "ns_count": None, "error": str(e)[:200]}


def build_targets() -> list[tuple[str, str, str]]:
    """(kind, server, domain) tuples."""
    targets: list[tuple[str, str, str]] = []
    for ns in TLD_NS:
        for d in SAMPLE_DOMAINS:
            targets.append(("tld", ns, d))
    for groups, kind in [(PUBLIC_RESOLVERS, "public"),
                         (local_resolvers(), "local"),
                         (ATT_RESOLVERS, "att")]:
        for r in groups:
            for d in SAMPLE_DOMAINS:
                targets.append((kind, r, d))
            targets.append((kind, r, CONTROL_DOMAIN))
    return targets


def run_once() -> int:
    ts = datetime.now(timezone.utc).isoformat()
    run_id = int(time.time())
    targets = build_targets()
    rows = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        future_to_t = {ex.submit(probe, srv, dom): (kind, srv, dom)
                       for (kind, srv, dom) in targets}
        for fut in as_completed(future_to_t):
            kind, srv, dom = future_to_t[fut]
            r = fut.result()
            rows.append((ts, run_id, kind, srv, dom,
                         r["ok"], r["ms"], r["ns_count"], r["error"]))
    with sqlite3.connect(DB_PATH) as db:
        db.executemany(
            "INSERT INTO probes(ts, run_id, kind, server, domain, ok, ms, ns_count, error)"
            " VALUES (?,?,?,?,?,?,?,?,?)", rows)
    failures = sum(1 for r in rows if r[5] == 0 and r[2] == "tld")
    print(f"[{ts}] run={run_id} probes={len(rows)} tld_failures={failures}", flush=True)
    return run_id


def prober_loop(interval: int, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            run_once()
        except Exception as e:
            print(f"probe loop error: {e}", flush=True)
        stop.wait(interval)


INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>.co DNS monitor</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 1rem; max-width: 1200px; }
  h1 { margin: 0 0 .25rem; }
  .sub { color: #666; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #f6f6f6; position: sticky; top: 0; }
  td.ok { color: #097; }
  td.fail { color: #c33; font-weight: 600; }
  .grid { display: grid; grid-template-columns: max-content max-content 1fr; gap: 2px 8px; align-items: center; }
  .cell { width: 10px; height: 14px; display: inline-block; }
  .cell.ok { background: #2a2; }
  .cell.fail { background: #c33; }
  .cell.gap { background: #eee; }
  .row-label { font-family: ui-monospace, monospace; font-size: 12px; white-space: nowrap; }
  .kind { font-size: 11px; color: #666; text-transform: uppercase; }
  .legend { font-size: 12px; color: #666; margin-bottom: .5rem; }
  select, input { font: inherit; padding: 2px 4px; }
  .controls { margin-bottom: 1rem; }
</style>
</head>
<body>
<h1>.co DNS monitor</h1>
<div class="sub">Each cell = one probe run. Green=OK, red=FAIL. Newest on the right.</div>

<div class="controls">
  Window:
  <select id="window">
    <option value="60">last 60 runs</option>
    <option value="180" selected>last 180 runs</option>
    <option value="720">last 720 runs (~12h @1min)</option>
    <option value="1440">last 1440 runs (~24h)</option>
  </select>
  &nbsp; <span id="lastrun"></span>
  &nbsp; <button onclick="load()">refresh</button>
  &nbsp; <label><input type="checkbox" id="auto" checked> auto-refresh 30s</label>
</div>

<div class="legend">Hover a cell for timestamp + latency.</div>
<div id="heatmap"></div>

<h2>Latest run</h2>
<table id="latest"><thead><tr>
  <th>kind</th><th>server</th><th>domain</th><th>status</th><th>ms</th><th>ns</th><th>error</th>
</tr></thead><tbody></tbody></table>

<script>
async function load() {
  const w = document.getElementById('window').value;
  const [hist, latest] = await Promise.all([
    fetch('/api/history?limit=' + w).then(r => r.json()),
    fetch('/api/latest').then(r => r.json()),
  ]);
  renderHeatmap(hist);
  renderLatest(latest);
  document.getElementById('lastrun').textContent =
    latest.ts ? 'last run: ' + new Date(latest.ts).toLocaleString() : '(no data yet)';
}

function renderHeatmap(hist) {
  const runs = hist.runs;
  const series = hist.series;
  const container = document.getElementById('heatmap');
  const order = ['tld', 'public', 'local', 'att'];
  series.sort((a, b) => {
    const ka = order.indexOf(a.kind), kb = order.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    if (a.server !== b.server) return a.server.localeCompare(b.server);
    return a.domain.localeCompare(b.domain);
  });
  const html = ['<div class="grid">'];
  html.push('<div></div><div></div><div></div>');
  for (const s of series) {
    html.push(`<div class="kind">${s.kind}</div>`);
    html.push(`<div class="row-label">${s.server} → ${s.domain}</div>`);
    html.push('<div>');
    for (const r of runs) {
      const v = s.results[r];
      let cls = 'gap', title = `run ${r} (no data)`;
      if (v) {
        cls = v.ok ? 'ok' : 'fail';
        title = `${new Date(v.ts).toLocaleString()} — ${v.ok ? 'OK' : 'FAIL'} ${v.ms}ms` +
                (v.error ? ` (${v.error})` : '');
      }
      html.push(`<span class="cell ${cls}" title="${title.replace(/"/g,'&quot;')}"></span>`);
    }
    html.push('</div>');
  }
  html.push('</div>');
  container.innerHTML = html.join('');
}

function renderLatest(latest) {
  const tbody = document.querySelector('#latest tbody');
  tbody.innerHTML = '';
  for (const r of latest.rows || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.kind}</td>
      <td>${r.server}</td>
      <td>${r.domain}</td>
      <td class="${r.ok ? 'ok' : 'fail'}">${r.ok ? 'OK' : 'FAIL'}</td>
      <td>${r.ms ?? ''}</td>
      <td>${r.ns_count ?? ''}</td>
      <td>${r.error ?? ''}</td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById('window').addEventListener('change', load);
let timer = null;
function setAuto() {
  if (timer) { clearInterval(timer); timer = null; }
  if (document.getElementById('auto').checked) timer = setInterval(load, 30000);
}
document.getElementById('auto').addEventListener('change', setAuto);
setAuto();
load();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a, **kw):  # quiet
        pass

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/":
            body = INDEX_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/api/latest":
            self._json(self._latest()); return
        if url.path == "/api/history":
            q = parse_qs(url.query)
            limit = int(q.get("limit", ["180"])[0])
            self._json(self._history(limit)); return
        self.send_error(404)

    def _latest(self) -> dict:
        with sqlite3.connect(DB_PATH) as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT MAX(run_id) AS r FROM probes").fetchone()
            run = row["r"] if row else None
            if run is None:
                return {"ts": None, "run_id": None, "rows": []}
            rows = db.execute(
                "SELECT ts, kind, server, domain, ok, ms, ns_count, error"
                " FROM probes WHERE run_id=? ORDER BY kind, server, domain", (run,)
            ).fetchall()
            ts = rows[0]["ts"] if rows else None
            return {"ts": ts, "run_id": run, "rows": [dict(r) for r in rows]}

    def _history(self, limit: int) -> dict:
        with sqlite3.connect(DB_PATH) as db:
            db.row_factory = sqlite3.Row
            runs = [r["run_id"] for r in db.execute(
                "SELECT DISTINCT run_id FROM probes ORDER BY run_id DESC LIMIT ?",
                (limit,)).fetchall()]
            runs.reverse()
            if not runs:
                return {"runs": [], "series": []}
            placeholders = ",".join("?" * len(runs))
            rows = db.execute(
                f"SELECT run_id, ts, kind, server, domain, ok, ms, error"
                f" FROM probes WHERE run_id IN ({placeholders})", runs).fetchall()
        series_map: dict[tuple, dict] = {}
        for r in rows:
            key = (r["kind"], r["server"], r["domain"])
            s = series_map.setdefault(key, {
                "kind": r["kind"], "server": r["server"], "domain": r["domain"],
                "results": {},
            })
            s["results"][r["run_id"]] = {
                "ok": r["ok"], "ms": r["ms"], "ts": r["ts"], "error": r["error"],
            }
        return {"runs": runs, "series": list(series_map.values())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--interval", type=int, default=60, help="seconds between runs")
    args = ap.parse_args()

    init_db()
    stop = threading.Event()
    t = threading.Thread(target=prober_loop, args=(args.interval, stop), daemon=True)
    t.start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"serving http://{args.host}:{args.port}  (probe interval={args.interval}s, db={DB_PATH})",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        srv.server_close()


if __name__ == "__main__":
    main()
