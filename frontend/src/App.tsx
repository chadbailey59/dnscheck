import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import type { Category, HistoryData, LatestData, SeriesEntry, ProbeRow } from './types';

const CATEGORY_CONFIG: Record<Category, { label: string; subtitle: string; color: string }> = {
  authoritative: { label: 'Authoritative', subtitle: '.co TLD Nameservers', color: '#7c3aed' },
  third_party:   { label: 'Third-Party',   subtitle: 'Public Resolvers',    color: '#0284c7' },
  isp:           { label: 'ISP',           subtitle: 'Residential DNS',     color: '#059669' },
};

const CATEGORY_ORDER: Category[] = ['authoritative', 'third_party', 'isp'];

async function apiFetch<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// ── Summary cell state ────────────────────────────────────────

type CellState = 'ok' | 'partial' | 'fail' | 'gap';

function summaryCellState(series: SeriesEntry[], runId: number): { state: CellState; failures: number; total: number } {
  let total = 0, failures = 0;
  for (const s of series) {
    const v = s.results[runId];
    if (!v) continue;
    total++;
    if (!v.ok) failures++;
  }
  if (total === 0) return { state: 'gap', failures: 0, total: 0 };
  const rate = failures / total;
  const state: CellState = rate === 0 ? 'ok' : rate > 0.5 ? 'fail' : 'partial';
  return { state, failures, total };
}

// ── Root app ──────────────────────────────────────────────────

export default function App() {
  const [history, setHistory]             = useState<HistoryData | null>(null);
  const [limit, setLimit]                 = useState(180);
  const [auto, setAuto]                   = useState(true);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen]       = useState(false);
  const [groupBy, setGroupBy]             = useState<GroupBy>(
    () => (localStorage.getItem('dnscheck.groupBy') as GroupBy) ?? 'server'
  );

  const load = useCallback(async () => {
    try {
      setError(null);
      const h = await apiFetch<HistoryData>(`/api/history?limit=${limit}`);
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [auto, load]);
  useEffect(() => { localStorage.setItem('dnscheck.groupBy', groupBy); }, [groupBy]);

  const handleCellClick = useCallback((runId: number) => {
    setSelectedRunId(runId);
    setDetailOpen(true);
  }, []);

  const allSeries = history?.series ?? [];
  const lastRun   = history?.runs[history.runs.length - 1];
  const lastRunFails = lastRun != null ? allSeries.filter(s => s.results[lastRun]?.ok === false) : [];
  const authFail   = lastRunFails.filter(s => s.category === 'authoritative').length;
  const otherFail  = lastRunFails.filter(s => s.category !== 'authoritative').length;
  const allOk      = !loading && !error && lastRun != null && lastRunFails.length === 0;
  const lastTs     = lastRun != null
    ? allSeries.flatMap(s => s.results[lastRun] ? [s.results[lastRun].ts] : [])[0]
    : null;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>.co DNS Monitor</h1>
          {lastTs && <span className="last-run">Last run: {new Date(lastTs).toLocaleString()}</span>}
        </div>
        <div className="header-right">
          {authFail > 0  && <span className="badge badge-fail">{authFail} auth failure{authFail !== 1 ? 's' : ''}</span>}
          {otherFail > 0 && <span className="badge badge-warn">{otherFail} resolver failure{otherFail !== 1 ? 's' : ''}</span>}
          {allOk         && <span className="badge badge-ok">All OK</span>}
          {loading       && <span className="badge badge-muted">Loading…</span>}
        </div>
      </header>

      {error && <div className="error-banner">Error: {error}</div>}

      <div className="controls">
        <label>
          Window:{' '}
          <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={60}>60 runs (~1h)</option>
            <option value={180}>180 runs (~3h)</option>
            <option value={720}>720 runs (~12h)</option>
            <option value={1440}>1440 runs (~24h)</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          Auto-refresh 30s
        </label>
        <button onClick={() => void load()}>Refresh</button>
        <span className="hint">Click any cell to inspect that run</span>
        <label className="checkbox-label">
          Group by:
          <button
            className="group-toggle"
            onClick={() => setGroupBy(g => g === 'server' ? 'domain' : 'server')}
          >
            {groupBy === 'server' ? 'IP' : 'domain'}
          </button>
        </label>
      </div>

      {CATEGORY_ORDER.map(cat => (
        <CategorySection
          key={cat}
          config={CATEGORY_CONFIG[cat]}
          series={allSeries.filter(s => s.category === cat)}
          runs={history?.runs ?? []}
          lastRun={lastRun ?? null}
          onCellClick={handleCellClick}
          groupBy={groupBy}
        />
      ))}

      <DetailSection
        open={detailOpen}
        onToggle={() => setDetailOpen(o => !o)}
        selectedRunId={selectedRunId}
        availableRuns={history?.runs ?? []}
        onRunChange={setSelectedRunId}
      />
    </div>
  );
}

// ── Category section ──────────────────────────────────────────

function CategorySection({
  config, series, runs, lastRun, onCellClick, groupBy,
}: {
  config: { label: string; subtitle: string; color: string };
  series: SeriesEntry[];
  runs: number[];
  lastRun: number | null;
  onCellClick: (runId: number) => void;
  groupBy: GroupBy;
}) {
  const providers = useMemo(() => [...new Set(series.map(s => s.provider))], [series]);
  const failing   = lastRun != null ? series.filter(s => s.results[lastRun]?.ok === false).length : 0;

  return (
    <section className="category-section">
      <div className="category-header" style={{ borderLeftColor: config.color }}>
        <span className="category-label" style={{ color: config.color }}>{config.label}</span>
        <span className="category-subtitle">{config.subtitle}</span>
        {series.length > 0 && (
          <span className="category-stats">
            {failing > 0
              ? <span className="stat-fail">{failing} failing</span>
              : <span className="stat-ok">all OK</span>}
          </span>
        )}
      </div>

      {providers.length === 0
        ? <div className="empty">No data yet — first poll pending</div>
        : providers.map(provider => (
            <ProviderGroup
              key={provider}
              provider={provider}
              series={series.filter(s => s.provider === provider)}
              runs={runs}
              onCellClick={onCellClick}
              groupBy={groupBy}
            />
          ))
      }
    </section>
  );
}

type GroupBy = 'server' | 'domain';

const TLD_ORDER = ['co', 'com', 'net', 'org'];
const getTld    = (domain: string) => domain.split('.').pop() ?? '';
const tldRank   = (domain: string) => {
  const i = TLD_ORDER.indexOf(getTld(domain));
  return i === -1 ? TLD_ORDER.length : i;
};

// ── Provider group (collapsible) ──────────────────────────────

function ProviderGroup({
  provider, series, runs, onCellClick, groupBy,
}: {
  provider: string;
  series: SeriesEntry[];
  runs: number[];
  onCellClick: (runId: number) => void;
  groupBy: GroupBy;
}) {
  const [expanded,    setExpanded]    = useState(false);
  const [showHealthy, setShowHealthy] = useState(false);

  const failingSeries = useMemo(
    () => series.filter(s => runs.some(r => s.results[r]?.ok === false)),
    [series, runs],
  );
  const healthyCount = series.length - failingSeries.length;

  const sortedSeries = useMemo(() => {
    const base = showHealthy ? series : failingSeries;
    return [...base].sort((a, b) =>
      groupBy === 'server'
        ? a.server.localeCompare(b.server)
            || tldRank(a.domain) - tldRank(b.domain)
            || a.domain.localeCompare(b.domain)
        : tldRank(a.domain) - tldRank(b.domain)
            || a.domain.localeCompare(b.domain)
            || a.server.localeCompare(b.server),
    );
  }, [series, failingSeries, showHealthy, groupBy]);

  // Spacers go between servers (by-server mode) or between TLDs (by-domain mode).
  const primaryKey = (s: SeriesEntry) =>
    groupBy === 'server' ? s.server : getTld(s.domain);

  return (
    <div className={`provider-group${expanded ? ' is-expanded' : ''}`}>
      {/* Summary row — always visible, click to expand */}
      <div className="provider-summary" onClick={() => setExpanded(e => !e)}>
        <div className="summary-left">
          <span className="summary-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="summary-label">{provider}</span>
        </div>
        <div className="summary-cells">
          {runs.map(r => (
            <SummaryCell key={r} runId={r} series={series} onCellClick={onCellClick} />
          ))}
        </div>
      </div>

      {/* Detail rows — only when expanded */}
      {expanded && (
        <div className="provider-detail">
          {sortedSeries.map((s, i) => (
            <div key={`${s.server}\x00${s.domain}`}>
              {i > 0 && primaryKey(s) !== primaryKey(sortedSeries[i - 1]) && (
                <div className="group-spacer" />
              )}
              <HeatmapRow
                series={s}
                runs={runs}
                onCellClick={onCellClick}
                groupBy={groupBy}
              />
            </div>
          ))}

          {failingSeries.length === 0 && (
            <div className="all-healthy">
              All {series.length} row{series.length !== 1 ? 's' : ''} healthy in this window
            </div>
          )}

          {!showHealthy && healthyCount > 0 && (
            <button
              className="show-healthy-btn"
              onClick={e => { e.stopPropagation(); setShowHealthy(true); }}
            >
              ↳ {healthyCount} healthy row{healthyCount !== 1 ? 's' : ''} hidden — show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Summary cell (aggregated) ─────────────────────────────────

const SummaryCell = memo(function SummaryCell({
  runId, series, onCellClick,
}: {
  runId: number;
  series: SeriesEntry[];
  onCellClick: (runId: number) => void;
}) {
  const { state, failures, total } = summaryCellState(series, runId);
  const title = state === 'gap' ? `run ${runId} — no data`
    : failures === 0 ? `All ${total} OK`
    : `${failures}/${total} failed`;
  return (
    <span
      className={`cell cell-${state}`}
      title={title}
      onClick={e => { e.stopPropagation(); onCellClick(runId); }}
    />
  );
});

// ── Individual heatmap row ────────────────────────────────────

function HeatmapRow({
  series, runs, onCellClick, groupBy,
}: {
  series: SeriesEntry;
  runs: number[];
  onCellClick: (runId: number) => void;
  groupBy: GroupBy;
}) {
  const primary   = groupBy === 'server' ? series.server : series.domain;
  const secondary = groupBy === 'server' ? series.domain : series.server;
  return (
    <div className="heatmap-row">
      <div className="row-primary"   title={primary}>{primary}</div>
      <div className="row-secondary" title={secondary}>{secondary}</div>
      <div className="row-cells">
        {runs.map(r => {
          const v = series.results[r];
          if (!v) return <span key={r} className="cell cell-gap" title={`run ${r} — no data`} />;
          const ts    = new Date(v.ts).toLocaleString();
          const title = `${ts} — ${v.ok ? 'OK' : 'FAIL'} ${v.ms ?? '?'}ms${v.error ? ` (${v.error})` : ''}\nClick to inspect`;
          return (
            <span
              key={r}
              className={`cell ${v.ok ? 'cell-ok' : 'cell-fail'}`}
              title={title}
              onClick={() => onCellClick(r)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Detail section (lazy) ─────────────────────────────────────

function DetailSection({
  open, onToggle, selectedRunId, availableRuns, onRunChange,
}: {
  open: boolean;
  onToggle: () => void;
  selectedRunId: number | null;
  availableRuns: number[];
  onRunChange: (runId: number) => void;
}) {
  const [data, setData]         = useState<LatestData | null>(null);
  const [loading, setLoading]   = useState(false);
  const [loadedId, setLoadedId] = useState<number | null>(null);

  const effectiveRunId = selectedRunId ?? (availableRuns[availableRuns.length - 1] ?? null);

  useEffect(() => {
    if (!open || effectiveRunId === null || effectiveRunId === loadedId) return;
    setLoading(true);
    const url = selectedRunId != null ? `/api/latest?run_id=${selectedRunId}` : '/api/latest';
    apiFetch<LatestData>(url)
      .then(d => { setData(d); setLoadedId(effectiveRunId); })
      .catch(e => console.error('detail fetch:', e))
      .finally(() => setLoading(false));
  }, [open, effectiveRunId, loadedId, selectedRunId]);

  const displayTs = data?.ts ? new Date(data.ts).toLocaleString() : null;

  return (
    <section className="detail-section">
      <button className="detail-toggle" onClick={onToggle}>
        <span className="toggle-arrow">{open ? '▾' : '▸'}</span>
        <span className="toggle-label">Run Detail</span>
        {!open && displayTs && <span className="toggle-hint">{displayTs}</span>}
        {!open && !displayTs && availableRuns.length > 0 && (
          <span className="toggle-hint">click to inspect a run</span>
        )}
      </button>

      {open && (
        <div className="detail-body">
          <div className="detail-controls">
            <label>
              Run:{' '}
              <select
                value={effectiveRunId ?? ''}
                onChange={e => onRunChange(Number(e.target.value))}
              >
                {[...availableRuns].reverse().map(r => (
                  <option key={r} value={r}>
                    {new Date(r).toLocaleString()} ({r})
                  </option>
                ))}
              </select>
            </label>
            {loading    && <span className="detail-loading">Loading…</span>}
            {displayTs && !loading && <span className="detail-ts">{displayTs}</span>}
          </div>

          {data && !loading && <RunTable rows={data.rows} />}
        </div>
      )}
    </section>
  );
}

// ── Run detail table ──────────────────────────────────────────

function RunTable({ rows }: { rows: ProbeRow[] }) {
  const grouped = CATEGORY_ORDER.reduce<Record<string, ProbeRow[]>>((acc, cat) => {
    acc[cat] = rows.filter(r => r.category === cat);
    return acc;
  }, {});

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Category</th><th>Provider</th><th>Server</th><th>Domain</th>
            <th>Status</th><th>ms</th><th>NS</th><th>Error</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORY_ORDER.flatMap(cat =>
            grouped[cat]?.map((r, i) => (
              <tr key={`${cat}-${i}`} className={r.ok ? '' : 'row-fail'}>
                <td><span className={`tag tag-${cat}`}>{cat.replace('_', '-')}</span></td>
                <td>{r.provider}</td>
                <td className="mono">{r.server}</td>
                <td className="mono">{r.domain}</td>
                <td className={r.ok ? 'status-ok' : 'status-fail'}>{r.ok ? 'OK' : 'FAIL'}</td>
                <td>{r.ms ?? ''}</td>
                <td>{r.ns_count ?? ''}</td>
                <td className="error-cell">{r.error ?? ''}</td>
              </tr>
            )) ?? [],
          )}
        </tbody>
      </table>
    </div>
  );
}
