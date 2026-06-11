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
  nsid: string | null;
  error: string | null;
}

export interface ProbeResult {
  ok: boolean;
  ms: number | null;
  ts: string;
  nsid: string | null;
  error: string | null;
}

export interface SeriesEntry {
  category: Category;
  provider: string;
  server: string;
  domain: string;
  nsid: string | null;
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
  nsid: string | null;
  common_error: string | null;
  last_ts: string;
}

export interface ContributorSummaryData {
  minutes: number;
  rows: ContributorSummaryRow[];
}
