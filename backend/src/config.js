'use strict';

const CO_DOMAINS  = ['daily.co', 'huggingface.co', 'hinge.co', 'g.co'];
const COM_DOMAINS = ['google.com', 'github.com', 'cloudflare.com', 'amazon.com'];
const NET_DOMAINS = ['speedtest.net', 'fastly.net', 'cloudflare.net', 'akamai.net'];
const ORG_DOMAINS = ['wikipedia.org', 'mozilla.org', 'archive.org', 'ietf.org'];

// Recursive resolvers get all domains so cross-TLD comparison is possible.
const ALL_DOMAINS = [...CO_DOMAINS, ...COM_DOMAINS, ...NET_DOMAINS, ...ORG_DOMAINS];

// Map used by the poller to pick the right domain list per authoritative TLD.
const DOMAINS_BY_TLD = { co: CO_DOMAINS, com: COM_DOMAINS, net: NET_DOMAINS, org: ORG_DOMAINS };

const TIMEOUT_SECS = 6;

// ISP resolver IPs from public records / AS data.
// These are best-effort — residential ISP DNS IPs can change.
const DNS_SERVERS = [
  // ── Authoritative: .co TLD (CCTLD / registry.co) ────────────────────────
  { server: 'a.registrydns.co', category: 'authoritative', provider: '.co Registry', tld: 'co' },
  { server: 'b.registrydns.co', category: 'authoritative', provider: '.co Registry', tld: 'co' },
  { server: 'c.registrydns.co', category: 'authoritative', provider: '.co Registry', tld: 'co' },
  { server: 'd.registrydns.co', category: 'authoritative', provider: '.co Registry', tld: 'co' },

  // ── Authoritative: .com TLD (ICANN gTLD servers) ─────────────────────────
  { server: 'a.gtld-servers.net', category: 'authoritative', provider: '.com gTLD', tld: 'com' },
  { server: 'b.gtld-servers.net', category: 'authoritative', provider: '.com gTLD', tld: 'com' },
  { server: 'c.gtld-servers.net', category: 'authoritative', provider: '.com gTLD', tld: 'com' },
  { server: 'd.gtld-servers.net', category: 'authoritative', provider: '.com gTLD', tld: 'com' },

  // ── Authoritative: .net TLD (same ICANN gTLD servers as .com) ────────────
  { server: 'a.gtld-servers.net', category: 'authoritative', provider: '.net gTLD', tld: 'net' },
  { server: 'b.gtld-servers.net', category: 'authoritative', provider: '.net gTLD', tld: 'net' },
  { server: 'c.gtld-servers.net', category: 'authoritative', provider: '.net gTLD', tld: 'net' },
  { server: 'd.gtld-servers.net', category: 'authoritative', provider: '.net gTLD', tld: 'net' },

  // ── Authoritative: .org TLD (Public Interest Registry / Afilias) ─────────
  { server: 'a0.org.afilias-nst.info', category: 'authoritative', provider: '.org PIR', tld: 'org' },
  { server: 'a2.org.afilias-nst.info', category: 'authoritative', provider: '.org PIR', tld: 'org' },
  { server: 'b0.org.afilias-nst.info', category: 'authoritative', provider: '.org PIR', tld: 'org' },
  { server: 'b2.org.afilias-nst.info', category: 'authoritative', provider: '.org PIR', tld: 'org' },

  // ── Third-party (public resolvers) ───────────────────────────────────────
  { server: '1.1.1.1',           category: 'third_party', provider: 'Cloudflare' },
  { server: '1.0.0.1',           category: 'third_party', provider: 'Cloudflare' },
  { server: '8.8.8.8',           category: 'third_party', provider: 'Google' },
  { server: '8.8.4.4',           category: 'third_party', provider: 'Google' },
  { server: '9.9.9.9',           category: 'third_party', provider: 'Quad9' },
  { server: '149.112.112.112',   category: 'third_party', provider: 'Quad9' },
  { server: '208.67.222.222',    category: 'third_party', provider: 'OpenDNS' },
  { server: '208.67.220.220',    category: 'third_party', provider: 'OpenDNS' },

  // ── ISP resolvers ─────────────────────────────────────────────────────────
  // AT&T residential (national)
  { server: '68.94.156.1',       category: 'isp', provider: 'AT&T' },
  { server: '68.94.157.1',       category: 'isp', provider: 'AT&T' },
  // AT&T / BellSouth Southeast — Georgia / LA / MS / TN
  { server: '205.152.37.23',     category: 'isp', provider: 'AT&T (BellSouth SE)' },
  { server: '205.152.144.23',    category: 'isp', provider: 'AT&T (BellSouth SE)' },
  { server: '205.152.132.23',    category: 'isp', provider: 'AT&T (BellSouth SE)' },
  // Verizon / Level3 (commonly used by Verizon FiOS customers)
  { server: '4.2.2.1',           category: 'isp', provider: 'Verizon/Level3' },
  { server: '4.2.2.2',           category: 'isp', provider: 'Verizon/Level3' },
  // CenturyLink / Lumen
  // NOTE: Comcast (75.75.75.75/76.76), Cox (68.105.28.11/29.11), and
  // Charter/Spectrum (75.168.0.1) were removed — all firewall port 53
  // to non-subscriber IPs and return refused/timeout from outside their network.
  { server: '205.171.3.65',      category: 'isp', provider: 'CenturyLink/Lumen' },
  { server: '205.171.2.65',      category: 'isp', provider: 'CenturyLink/Lumen' },
];

const EXCLUDE_PROVIDERS = process.env.EXCLUDE_PROVIDERS
  ? new Set(process.env.EXCLUDE_PROVIDERS.split(',').map(s => s.trim()))
  : new Set();

// POLL_SERVERS omits providers that won't respond from this network.
// DNS_SERVERS retains all of them so the UI can show gaps for unpolled servers.
const POLL_SERVERS = EXCLUDE_PROVIDERS.size > 0
  ? DNS_SERVERS.filter(s => !EXCLUDE_PROVIDERS.has(s.provider))
  : DNS_SERVERS;

module.exports = { DNS_SERVERS, POLL_SERVERS, ALL_DOMAINS, DOMAINS_BY_TLD, TIMEOUT_SECS };
