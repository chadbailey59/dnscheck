export type Category = 'authoritative' | 'third_party' | 'isp';

export interface ProbeRow {
  ts: string;
  category: Category;
  provider: string;
  server: string;
  domain: string;
  ok: boolean;
  ms: number | null;
  ns_count: number | null;
  error: string | null;
}

export interface ProbeResult {
  ok: boolean;
  ms: number | null;
  ts: string;
  error: string | null;
}

export interface SeriesEntry {
  category: Category;
  provider: string;
  server: string;
  domain: string;
  results: Record<number, ProbeResult>;
}

export interface HistoryData {
  runs: number[];
  series: SeriesEntry[];
}

export interface LatestData {
  ts: string | null;
  run_id: number | null;
  rows: ProbeRow[];
}

export interface ContributorSummaryRow {
  provider: string;
  server: string;
  domain: string;
  uploads: string | number;
  contributors: string | number;
  rows: string | number;
  failures: string | number;
  median_ms: number | null;
  common_error: string | null;
  last_ts: string;
}

export interface ContributorSummaryData {
  minutes: number;
  rows: ContributorSummaryRow[];
}
