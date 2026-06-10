import { useState, useEffect, useCallback, useMemo, memo, type MouseEvent } from 'react';
import type {
  Category,
  ContributorSummaryData,
  ContributorSummaryRow,
  HistoryData,
  LatestData,
  SeriesEntry,
  ProbeRow,
} from './types';

const CATEGORY_CONFIG: Record<Category, { label: string; subtitle: string; color: string }> = {
  authoritative: { label: 'Authoritative', subtitle: '.co TLD Nameservers', color: '#7c3aed' },
  third_party:   { label: 'Third-Party',   subtitle: 'Public Resolvers',    color: '#0284c7' },
  isp:           { label: 'ISP',           subtitle: 'Residential DNS',     color: '#059669' },
};

const CATEGORY_ORDER: Category[] = ['authoritative', 'third_party', 'isp'];

const SPAN_OPTIONS = [
  { value: 60,    label: '1h' },
  { value: 180,   label: '3h' },
  { value: 720,   label: '12h' },
  { value: 1440,  label: '24h' },
  { value: 10080, label: '7d' },
];

async function apiFetch<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

function fmtDt(ts: string | number | Date): string {
  const d = new Date(ts instanceof Date ? ts : Number(ts) || ts);
  const local = d.toLocaleString();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${local} (${y}-${mo}-${day} ${h}:${m} UTC)`;
}

// Convert a Date to the value string expected by <input type="datetime-local">
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type DataSource = 'hosted' | 'contributor';
type GroupBy = 'server' | 'domain';
type RangeConfig = { span: number; endMs: number | null };

// ── Summary cell state ────────────────────────────────────────

type CellState = 'ok' | 'partial' | 'fail' | 'gap';
type TimelineBucket = {
  key: string;
  runs: number[];
  startRun: number;
  endRun: number;
};
type TimelineTooltip = {
  x: number;
  y: number;
  title: string;
  detail: string;
  state: CellState;
};

const MAX_TIMELINE_BUCKETS = 240;

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

function buildTimelineBuckets(runs: number[]): TimelineBucket[] {
  const bucketCount = Math.min(runs.length, MAX_TIMELINE_BUCKETS);
  if (bucketCount === 0) return [];

  return Array.from({ length: bucketCount }, (_, i) => {
    const start = Math.floor((i * runs.length) / bucketCount);
    const end = Math.floor(((i + 1) * runs.length) / bucketCount);
    const bucketRuns = runs.slice(start, Math.max(start + 1, end));
    const startRun = bucketRuns[0];
    const endRun = bucketRuns[bucketRuns.length - 1];
    return {
      key: `${startRun}-${endRun}`,
      runs: bucketRuns,
      startRun,
      endRun,
    };
  });
}

function summaryBucketState(series: SeriesEntry[], bucket: TimelineBucket): { state: CellState; failures: number; total: number } {
  let total = 0, failures = 0;
  let hasOk = false, hasPartial = false, hasFail = false;

  for (const runId of bucket.runs) {
    const runState = summaryCellState(series, runId);
    total += runState.total;
    failures += runState.failures;
    if (runState.state === 'ok') hasOk = true;
    if (runState.state === 'partial') hasPartial = true;
    if (runState.state === 'fail') hasFail = true;
  }

  if (total === 0) return { state: 'gap', failures: 0, total: 0 };
  if (hasFail) return { state: 'fail', failures, total };
  if (hasPartial) return { state: 'partial', failures, total };
  return { state: hasOk ? 'ok' : 'gap', failures, total };
}

function timelineRangeTitle(bucket: TimelineBucket): string {
  const start = fmtDt(bucket.startRun);
  const end = fmtDt(bucket.endRun);
  return bucket.startRun === bucket.endRun
    ? start
    : `${start} – ${end} (${bucket.runs.length} runs)`;
}

function formatCellDetail(state: CellState, failures: number, total: number): string {
  if (state === 'gap' || total === 0) return 'No data';
  if (failures === 0) return `All ${total} OK`;
  return `${failures}/${total} failed`;
}

// ── Root app ──────────────────────────────────────────────────

export default function App() {
  const [history, setHistory]                 = useState<HistoryData | null>(null);
  const [contributorHistory, setContributorHistory] = useState<HistoryData | null>(null);
  const [contributors, setContributors]       = useState<ContributorSummaryData | null>(null);
  const [range, setRange]                     = useState<RangeConfig>(() => ({
    span: parseInt(localStorage.getItem('dnscheck.span') ?? '180', 10) || 180,
    endMs: null,
  }));
  const [auto, setAuto]                       = useState(true);
  const [dataLoaded, setDataLoaded]           = useState(false);
  const [rangeLoading, setRangeLoading]       = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId]     = useState<number | null>(null);
  const [detailSource, setDetailSource]       = useState<DataSource>('hosted');
  const [detailOpen, setDetailOpen]           = useState(false);
  const [groupBy, setGroupBy]                 = useState<GroupBy>(
    () => (localStorage.getItem('dnscheck.groupBy') as GroupBy) ?? 'server'
  );
  // Controlled value for the datetime-local input (local time string)
  const [endInputValue, setEndInputValue]     = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const beforeParam = range.endMs != null ? `&before=${range.endMs}` : '';
      const [h, ph, c] = await Promise.all([
        apiFetch<HistoryData>(`/api/history?limit=${range.span}${beforeParam}`),
        apiFetch<HistoryData>(`/api/contributors/history?limit=${range.span}${beforeParam}`),
        apiFetch<ContributorSummaryData>(`/api/contributors/summary?minutes=${range.span}${beforeParam}`),
      ]);
      setHistory(h);
      setContributorHistory(ph);
      setContributors(c);
      setDataLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRangeLoading(false);
    }
  }, [range]);

  // Load on range change (shows spinner)
  useEffect(() => {
    setRangeLoading(true);
    void load();
  }, [load]);

  // Auto-refresh — only when live (no fixed end time)
  useEffect(() => {
    if (!auto || range.endMs !== null) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [auto, load, range.endMs]);

  useEffect(() => { localStorage.setItem('dnscheck.groupBy', groupBy); }, [groupBy]);
  useEffect(() => { localStorage.setItem('dnscheck.span', String(range.span)); }, [range.span]);

  const handleDetailSourceChange = useCallback((source: DataSource) => {
    setDetailSource(source);
    setSelectedRunId(null);
  }, []);

  const handleEndTimeChange = useCallback((value: string) => {
    setEndInputValue(value);
    if (value === '') {
      setRange(r => ({ ...r, endMs: null }));
    } else {
      const ms = new Date(value).getTime();
      if (Number.isFinite(ms)) {
        setRange(r => ({ ...r, endMs: ms }));
      }
    }
  }, []);

  const handleGoLive = useCallback(() => {
    setEndInputValue('');
    setRange(r => ({ ...r, endMs: null }));
    setAuto(true);
  }, []);

  const isLive = range.endMs === null;

  const allSeries = history?.series ?? [];
  const lastRun   = history?.runs[history.runs.length - 1];
  const lastRunFails = lastRun != null ? allSeries.filter(s => s.results[lastRun]?.ok === false) : [];
  const authFail   = lastRunFails.filter(s => s.category === 'authoritative').length;
  const otherFail  = lastRunFails.filter(s => s.category !== 'authoritative').length;
  const allOk      = dataLoaded && !error && lastRun != null && lastRunFails.length === 0;
  const lastTs     = lastRun != null
    ? allSeries.flatMap(s => s.results[lastRun] ? [s.results[lastRun].ts] : [])[0]
    : null;
  const publisherSeries = contributorHistory?.series ?? [];
  const publisherRuns = contributorHistory?.runs ?? [];
  const publisherLastRun = publisherRuns[publisherRuns.length - 1] ?? null;
  const detailRuns = detailSource === 'contributor' ? publisherRuns : (history?.runs ?? []);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>.co DNS Monitor</h1>
          {lastTs && <span className="last-run">Last run: {fmtDt(lastTs)}</span>}
        </div>
        <div className="header-right">
          {authFail > 0  && <span className="badge badge-fail">{authFail} auth failure{authFail !== 1 ? 's' : ''}</span>}
          {otherFail > 0 && <span className="badge badge-warn">{otherFail} resolver failure{otherFail !== 1 ? 's' : ''}</span>}
          {allOk         && <span className="badge badge-ok">All OK</span>}
          {!dataLoaded && !error && <span className="badge badge-muted">Loading…</span>}
          {!isLive       && <span className="badge badge-muted">Historical</span>}
        </div>
      </header>

      {error && <div className="error-banner">Error: {error}</div>}

      <div className="controls">
        <label>
          Span:{' '}
          <select
            value={range.span}
            onChange={e => setRange(r => ({ ...r, span: Number(e.target.value) }))}
          >
            {SPAN_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label>
          End:{' '}
          <input
            type="datetime-local"
            value={endInputValue}
            max={toDatetimeLocal(new Date())}
            onChange={e => handleEndTimeChange(e.target.value)}
            className="end-time-input"
          />
        </label>
        {!isLive && (
          <button onClick={handleGoLive} className="live-btn">↩ Live</button>
        )}

        {isLive && (
          <label className="checkbox-label">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
            Auto-refresh 30s
          </label>
        )}
        <button onClick={() => void load()}>Refresh</button>
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

      <div className={`sections-wrapper${rangeLoading ? ' is-range-loading' : ''}`}>
        {rangeLoading && <div className="loading-spinner" />}

        {CATEGORY_ORDER.map(cat => (
          <CategorySection
            key={cat}
            config={CATEGORY_CONFIG[cat]}
            series={allSeries.filter(s => s.category === cat)}
            runs={history?.runs ?? []}
            lastRun={lastRun ?? null}
            groupBy={groupBy}
          />
        ))}

        <CategorySection
          config={{ label: 'Publisher Uploads', subtitle: 'Contributor DNS', color: '#475569' }}
          series={publisherSeries}
          runs={publisherRuns}
          lastRun={publisherLastRun}
          groupBy={groupBy}
          emptyText="No publisher uploads in this window"
        />

        <ContributorSection data={contributors} />
      </div>

      <DetailSection
        open={detailOpen}
        onToggle={() => setDetailOpen(o => !o)}
        source={detailSource}
        onSourceChange={handleDetailSourceChange}
        selectedRunId={selectedRunId}
        availableRuns={detailRuns}
        onRunChange={setSelectedRunId}
      />
    </div>
  );
}

// ── Contributor section ──────────────────────────────────────

function asCount(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function ContributorSection({ data }: { data: ContributorSummaryData | null }) {
  const rows = data?.rows ?? [];
  const providers = useMemo(() => [...new Set(rows.map(r => r.provider))], [rows]);
  const lastTs = rows
    .map(r => new Date(r.last_ts).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  return (
    <section className="category-section contributor-section">
      <div className="category-header contributor-header">
        <span className="category-label">Publisher Summary</span>
        <span className="category-subtitle">Last {data?.minutes ?? '...'} minutes</span>
        {lastTs && (
          <span className="category-stats">
            Last upload: {fmtDt(lastTs)}
          </span>
        )}
      </div>

      {rows.length === 0
        ? <div className="empty">No publisher uploads in this window</div>
        : providers.map(provider => (
            <ContributorProvider
              key={provider}
              provider={provider}
              rows={rows.filter(r => r.provider === provider)}
            />
          ))
      }
    </section>
  );
}

function ContributorProvider({ provider, rows }: { provider: string; rows: ContributorSummaryRow[] }) {
  const [expanded, setExpanded] = useState(provider === 'Other');
  const failures = rows.reduce((n, r) => n + asCount(r.failures), 0);
  const uploads = Math.max(0, ...rows.map(r => asCount(r.uploads)));
  const contributors = Math.max(0, ...rows.map(r => asCount(r.contributors)));
  const lastTs = rows
    .map(r => new Date(r.last_ts).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  const sortedRows = useMemo(() => [...rows].sort((a, b) =>
    a.server.localeCompare(b.server)
      || tldRank(a.domain) - tldRank(b.domain)
      || a.domain.localeCompare(b.domain)
  ), [rows]);

  return (
    <div className={`provider-group${expanded ? ' is-expanded' : ''}`}>
      <div className="contributor-summary" onClick={() => setExpanded(e => !e)}>
        <div className="summary-left">
          <span className="summary-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="summary-label">{provider}</span>
        </div>
        <div className="contributor-metrics">
          <span>{uploads} upload{uploads !== 1 ? 's' : ''}</span>
          <span>{contributors} contributor{contributors !== 1 ? 's' : ''}</span>
          <span className={failures > 0 ? 'stat-fail' : 'stat-ok'}>
            {failures} failure{failures !== 1 ? 's' : ''}
          </span>
          {lastTs && <span>{fmtDt(lastTs)}</span>}
        </div>
      </div>

      {expanded && (
        <div className="table-scroll contributor-table">
          <table>
            <thead>
              <tr>
                <th>Server</th><th>Domain</th><th>Uploads</th><th>Rows</th>
                <th>Failures</th><th>Median ms</th><th>Common Error</th><th>Last Upload</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(r => (
                <tr key={`${r.server}\x00${r.domain}`} className={asCount(r.failures) > 0 ? 'row-fail' : ''}>
                  <td className="mono">{r.server}</td>
                  <td className="mono">{r.domain}</td>
                  <td>{r.uploads}</td>
                  <td>{r.rows}</td>
                  <td className={asCount(r.failures) > 0 ? 'status-fail' : 'status-ok'}>{r.failures}</td>
                  <td>{r.median_ms ?? ''}</td>
                  <td className="error-cell">{r.common_error ?? ''}</td>
                  <td className="ts-cell">{fmtDt(r.last_ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Category section ──────────────────────────────────────────

function CategorySection({
  config, series, runs, lastRun, groupBy, emptyText = 'No data yet — first poll pending',
}: {
  config: { label: string; subtitle: string; color: string };
  series: SeriesEntry[];
  runs: number[];
  lastRun: number | null;
  groupBy: GroupBy;
  emptyText?: string;
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
        ? <div className="empty">{emptyText}</div>
        : providers.map(provider => (
            <ProviderGroup
              key={provider}
              provider={provider}
              series={series.filter(s => s.provider === provider)}
              runs={runs}
              groupBy={groupBy}
            />
          ))
      }
    </section>
  );
}

const TLD_ORDER = ['co', 'com', 'net', 'org'];
const getTld    = (domain: string) => domain.split('.').pop() ?? '';
const tldRank   = (domain: string) => {
  const i = TLD_ORDER.indexOf(getTld(domain));
  return i === -1 ? TLD_ORDER.length : i;
};

// ── Provider group (collapsible) ──────────────────────────────

function ProviderGroup({
  provider, series, runs, groupBy,
}: {
  provider: string;
  series: SeriesEntry[];
  runs: number[];
  groupBy: GroupBy;
}) {
  const [expanded,    setExpanded]    = useState(false);
  const [showHealthy, setShowHealthy] = useState(false);
  const [tooltip, setTooltip] = useState<TimelineTooltip | null>(null);

  const failingSeries = useMemo(
    () => series.filter(s => runs.some(r => s.results[r]?.ok === false)),
    [series, runs],
  );
  const healthyCount = series.length - failingSeries.length;
  const timelineBuckets = useMemo(() => buildTimelineBuckets(runs), [runs]);

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
  const showTooltip = useCallback((e: MouseEvent<HTMLElement>, nextTooltip: Omit<TimelineTooltip, 'x' | 'y'>) => {
    setTooltip({
      ...nextTooltip,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);
  const moveTooltip = useCallback((e: MouseEvent<HTMLElement>) => {
    setTooltip(current => current ? { ...current, x: e.clientX, y: e.clientY } : current);
  }, []);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  return (
    <div className={`provider-group${expanded ? ' is-expanded' : ''}`}>
      {/* Summary row — always visible, click to expand */}
      <div className="provider-summary" onClick={() => setExpanded(e => !e)}>
        <div className="summary-left">
          <span className="summary-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="summary-label">{provider}</span>
        </div>
        <div className="summary-cells">
          {timelineBuckets.map(bucket => (
            <SummaryCell
              key={bucket.key}
              bucket={bucket}
              series={series}
              onTooltipShow={showTooltip}
              onTooltipMove={moveTooltip}
              onTooltipHide={hideTooltip}
            />
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
                buckets={timelineBuckets}
                groupBy={groupBy}
                onTooltipShow={showTooltip}
                onTooltipMove={moveTooltip}
                onTooltipHide={hideTooltip}
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
      {tooltip && <TimelineHoverTooltip tooltip={tooltip} />}
    </div>
  );
}

// ── Summary cell (aggregated) ─────────────────────────────────

const SummaryCell = memo(function SummaryCell({
  bucket, series, onTooltipShow, onTooltipMove, onTooltipHide,
}: {
  bucket: TimelineBucket;
  series: SeriesEntry[];
  onTooltipShow: (e: MouseEvent<HTMLElement>, tooltip: Omit<TimelineTooltip, 'x' | 'y'>) => void;
  onTooltipMove: (e: MouseEvent<HTMLElement>) => void;
  onTooltipHide: () => void;
}) {
  const { state, failures, total } = summaryBucketState(series, bucket);
  const range = timelineRangeTitle(bucket);
  const detail = formatCellDetail(state, failures, total);
  const title = `${range} - ${detail}`;
  return (
    <span
      className={`cell cell-${state}`}
      title={title}
      onMouseEnter={e => onTooltipShow(e, { title: range, detail, state })}
      onMouseMove={onTooltipMove}
      onMouseLeave={onTooltipHide}
    />
  );
});

// ── Individual heatmap row ────────────────────────────────────

function HeatmapRow({
  series, buckets, groupBy, onTooltipShow, onTooltipMove, onTooltipHide,
}: {
  series: SeriesEntry;
  buckets: TimelineBucket[];
  groupBy: GroupBy;
  onTooltipShow: (e: MouseEvent<HTMLElement>, tooltip: Omit<TimelineTooltip, 'x' | 'y'>) => void;
  onTooltipMove: (e: MouseEvent<HTMLElement>) => void;
  onTooltipHide: () => void;
}) {
  const primary   = groupBy === 'server' ? series.server : series.domain;
  const secondary = groupBy === 'server' ? series.domain : series.server;
  return (
    <div className="heatmap-row">
      <div className="row-primary"   title={primary}>{primary}</div>
      <div className="row-secondary" title={secondary}>{secondary}</div>
      <div className="row-cells">
        {buckets.map(bucket => {
          const values = bucket.runs.map(r => series.results[r]).filter(Boolean);
          const range = timelineRangeTitle(bucket);
          if (values.length === 0) {
            const detail = formatCellDetail('gap', 0, 0);
            return (
              <span
                key={bucket.key}
                className="cell cell-gap"
                title={`${range} - ${detail}`}
                onMouseEnter={e => onTooltipShow(e, { title: range, detail, state: 'gap' })}
                onMouseMove={onTooltipMove}
                onMouseLeave={onTooltipHide}
              />
            );
          }

          const failures = values.filter(v => !v.ok);
          const failingValue = failures[failures.length - 1];
          const state = failures.length > 0 ? 'fail' : 'ok';
          const detail = formatCellDetail(state, failures.length, values.length);
          const title = `${range} - ${detail}${failingValue?.error ? ` (${failingValue.error})` : ''}`;
          return (
            <span
              key={bucket.key}
              className={`cell cell-${state}`}
              title={title}
              onMouseEnter={e => onTooltipShow(e, { title: range, detail, state })}
              onMouseMove={onTooltipMove}
              onMouseLeave={onTooltipHide}
            />
          );
        })}
      </div>
    </div>
  );
}

function TimelineHoverTooltip({ tooltip }: { tooltip: TimelineTooltip }) {
  const width = Math.min(300, window.innerWidth - 24);
  const x = Math.min(Math.max(tooltip.x, 12 + width / 2), window.innerWidth - 12 - width / 2);
  const y = Math.max(tooltip.y, 56);

  return (
    <div
      className={`timeline-tooltip tooltip-${tooltip.state}`}
      style={{ left: x, top: y }}
      role="tooltip"
    >
      <div className="tooltip-range">{tooltip.title}</div>
      <div className="tooltip-detail">{tooltip.detail}</div>
    </div>
  );
}

// ── Detail section (lazy) ─────────────────────────────────────

function DetailSection({
  open, onToggle, source, onSourceChange, selectedRunId, availableRuns, onRunChange,
}: {
  open: boolean;
  onToggle: () => void;
  source: DataSource;
  onSourceChange: (source: DataSource) => void;
  selectedRunId: number | null;
  availableRuns: number[];
  onRunChange: (runId: number) => void;
}) {
  const [data, setData]         = useState<LatestData | null>(null);
  const [loading, setLoading]   = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const effectiveRunId = selectedRunId ?? (availableRuns[availableRuns.length - 1] ?? null);
  const effectiveKey = effectiveRunId === null ? null : `${source}:${effectiveRunId}`;

  useEffect(() => {
    if (!open) return;
    if (effectiveRunId === null) {
      setData(null);
      setLoadedKey(null);
      return;
    }
    if (effectiveKey === loadedKey) return;
    setLoading(true);
    setData(null);
    const baseUrl = source === 'contributor' ? '/api/contributors/latest' : '/api/latest';
    const url = selectedRunId != null ? `${baseUrl}?run_id=${selectedRunId}` : baseUrl;
    apiFetch<LatestData>(url)
      .then(d => { setData(d); setLoadedKey(effectiveKey); })
      .catch(e => console.error('detail fetch:', e))
      .finally(() => setLoading(false));
  }, [open, source, effectiveRunId, effectiveKey, loadedKey, selectedRunId]);

  const displayTs = data?.ts ? fmtDt(data.ts) : null;

  return (
    <section className="detail-section">
      <button className="detail-toggle" onClick={onToggle}>
        <span className="toggle-arrow">{open ? '▾' : '▸'}</span>
        <span className="toggle-label">Run Detail</span>
        <span className="toggle-hint">{source === 'contributor' ? 'publisher' : 'hosted'}</span>
        {!open && displayTs && <span className="toggle-hint">{displayTs}</span>}
        {!open && !displayTs && availableRuns.length > 0 && (
          <span className="toggle-hint">latest run</span>
        )}
      </button>

      {open && (
        <div className="detail-body">
          <div className="detail-controls">
            <label>
              Source:{' '}
              <select
                value={source}
                onChange={e => onSourceChange(e.target.value as DataSource)}
              >
                <option value="hosted">Hosted</option>
                <option value="contributor">Publisher</option>
              </select>
            </label>
            <label>
              Run:{' '}
              <select
                value={effectiveRunId ?? ''}
                onChange={e => onRunChange(Number(e.target.value))}
              >
                {[...availableRuns].reverse().map(r => (
                  <option key={r} value={r}>
                    {fmtDt(r)}
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
