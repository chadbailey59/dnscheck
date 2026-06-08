# Contributor Probe

The contributor probe is a small Docker target that discovers the runner's ISP,
probes that ISP's known recursive DNS servers every minute, and uploads only DNS
result rows to the hosted `/api/probes` endpoint.

Run the published image:

```sh
docker run --rm --pull always --network host chadbailey59/dnscheck-contributor:latest
```

Leave it running; it sends a batch immediately and then repeats every minute
until stopped.

Build it locally:

```sh
docker build --target contributor -t dnscheck-contributor .
```

Run the local build:

```sh
docker run --rm \
  --network host \
  dnscheck-contributor
```

`--network host` is recommended on Linux so traceroute sees the same network path
as the host. Docker Desktop platforms may route through a VM, so ISP detection can
be less precise there.

Each run generates a fresh anonymous contributor UUID and upload UUID. The upload
UUID is used to ignore accidental duplicate rows from the same batch.

If automatic ISP detection fails, the probe publishes under `Other` using the
system DNS resolver path. You can also set the provider explicitly:

```sh
docker run --rm \
  --network host \
  -e ISP_PROVIDER="AT&T" \
  --pull always \
  chadbailey59/dnscheck-contributor:latest
```

Supported provider labels are currently:

- `AT&T`
- `Comcast/Xfinity`
- `Cox`
- `Charter/Spectrum`
- `CenturyLink/Lumen`
- `Verizon/Level3`
- `Other`

Optional settings:

- `DOMAINS`: comma-separated domains to probe instead of the app's default set.
- `TRACE_TARGET`: traceroute target, default `9.9.9.9`.
- `TRACE_MAX_HOPS`: maximum hops for ISP discovery, default `8`.
- `TRACE_WAIT_SECS`: traceroute wait per hop, default `2`.
- `PROBE_INTERVAL_MS`: wall-clock interval for upload batches, default `60000`.
  The default starts batches at the beginning of each minute when possible.
- `DNSCHECK_UPLOAD_URL`: upload endpoint, default `https://dnscheck.fun/api/probes`.
- `DNSCHECK_DISABLE_RDAP=1`: skip RDAP lookup and rely on traceroute/PTR text.
- `DNSCHECK_CONTRIBUTOR_ID`: explicit contributor UUID override.

The upload includes the anonymous contributor UUID, upload UUID, and DNS result
rows. It does not include traceroute output, public hop IPs, source IP, or user
agent.

To remove one uploaded run's stored results by contributor UUID:

```sql
DELETE FROM probes WHERE contributor_id = '00000000-0000-4000-8000-000000000000';
```
