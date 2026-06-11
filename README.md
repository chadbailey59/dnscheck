# DNSCheck Contributor

Run this if you want to contribute DNS results from your ISP network:

```sh
docker run --rm --pull always --network host chadbailey59/dnscheck-contributor:latest
```

The image uploads to `https://dnscheck.fun/api/probes` by default and sends a new
batch every minute until stopped.

Each run generates a fresh anonymous contributor UUID and upload UUID. The upload
includes those UUIDs and DNS probe results only; it does not include traceroute
output, public hop IPs, source IP, or user agent.

If ISP detection fails, the probe publishes under `Other` using the system DNS
resolver path. You can also run it with a provider override:

```sh
docker run --rm --pull always --network host -e ISP_PROVIDER="AT&T" chadbailey59/dnscheck-contributor:latest
```

To run it in the background:

```sh
docker run -d --name dnscheck-contributor --pull always --network host --restart unless-stopped chadbailey59/dnscheck-contributor:latest
```

Stop it later with:

```sh
docker stop dnscheck-contributor
docker rm dnscheck-contributor
```

Supported provider labels:

- `AT&T`
- `Comcast/Xfinity`
- `Cox`
- `Charter/Spectrum`
- `CenturyLink/Lumen`
- `Verizon/Level3`
- `Other`

For local development:

```sh
docker build --target contributor -t dnscheck-contributor .
docker run --rm --network host dnscheck-contributor
```

More options are documented in [CONTRIBUTOR.md](CONTRIBUTOR.md).

## Anycast Diagnostics

To test whether `.co` authoritative results differ because local and hosted
probes are routed to different anycast instances, run:

```sh
cd backend
npm run anycast
```

The command queries the direct `.co` registry IPs with `dig +nsid` and prints
JSON containing the backend NSID, query latency, and a short route sample when
`tracepath` or `traceroute` is available.

Run the same command from a Render shell or one-off job after deploying. If the
local and Render runs show different `nsid_text` values, they are reaching
different authoritative backends. If only one origin fails and its NSID or route
is different, that supports the anycast-routing hypothesis.

Optional overrides:

```sh
ANYCAST_DOMAIN=hinge.co npm run anycast
ANYCAST_TARGETS=194.169.218.57,212.18.248.57 npm run anycast
```
