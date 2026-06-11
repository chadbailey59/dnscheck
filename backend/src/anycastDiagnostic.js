'use strict';

const { execFile } = require('child_process');

const DEFAULT_TARGETS = [
  '194.169.218.57',
  '185.24.64.57',
  '212.18.248.57',
  '212.18.249.57',
];

const DOMAIN = process.env.ANYCAST_DOMAIN || 'daily.co';
const TARGETS = (process.env.ANYCAST_TARGETS || DEFAULT_TARGETS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function execCommand(cmd, args, timeoutMs = 10000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err ? (err.code ?? 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        timedOut: err?.killed ?? false,
      });
    });
  });
}

function parseDig(output) {
  const status = /status:\s*([A-Z]+)/.exec(output)?.[1] ?? null;
  const queryMs = /Query time:\s*(\d+)\s*msec/.exec(output)?.[1] ?? null;
  const server = /SERVER:\s*([^\s]+)/.exec(output)?.[1] ?? null;
  const nsidMatch = /;\s*NSID:\s*([0-9A-Fa-f ]+)(?:\s*\("([^"]+)"\))?/.exec(output);

  return {
    status,
    query_ms: queryMs == null ? null : Number(queryMs),
    server,
    nsid_hex: nsidMatch?.[1]?.trim().replace(/\s+/g, ' ') ?? null,
    nsid_text: nsidMatch?.[2] ?? null,
  };
}

async function digNsid(target) {
  const result = await execCommand('dig', [
    '+tries=1',
    '+time=4',
    '+nsid',
    '+norecurse',
    `@${target}`,
    DOMAIN,
    'NS',
  ], 7000);
  const output = `${result.stdout}${result.stderr}`;
  return {
    command: `dig +tries=1 +time=4 +nsid +norecurse @${target} ${DOMAIN} NS`,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    ...parseDig(output),
    error: result.ok ? null : output.trim().split('\n').slice(-2).join(' | '),
  };
}

async function findRouteTool() {
  for (const [cmd, args] of [
    ['tracepath', ['-n', '-m', '12']],
    ['traceroute', ['-n', '-m', '12', '-w', '1']],
  ]) {
    const found = await execCommand('sh', ['-c', `command -v ${cmd}`], 2000);
    if (found.ok && found.stdout.trim()) return { cmd, args };
  }
  return null;
}

async function traceRoute(target, tool) {
  if (!tool) return { available: false };
  const result = await execCommand(tool.cmd, [...tool.args, target], 15000);
  const lines = `${result.stdout}${result.stderr}`
    .trim()
    .split('\n')
    .filter(Boolean);
  return {
    available: true,
    command: `${tool.cmd} ${[...tool.args, target].join(' ')}`,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    output: lines.slice(0, 16),
  };
}

async function main() {
  const routeTool = await findRouteTool();
  const results = await Promise.all(TARGETS.map(async target => {
    const [dns, route] = await Promise.all([
      digNsid(target),
      traceRoute(target, routeTool),
    ]);
    return { target, dns, route };
  }));

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    domain: DOMAIN,
    targets: TARGETS,
    route_tool: routeTool?.cmd ?? null,
    results,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
