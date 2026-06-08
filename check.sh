#!/usr/bin/env bash
# Probe the .co TLD authoritative nameservers (a-d.registrydns.co) and a few
# public resolvers, to detect intermittent registrydns.co outages.
#
# Usage:
#   ./check.sh                # one run, human-readable output
#   ./check.sh --loop 5m      # repeat every 5 minutes until Ctrl-C
#   ./check.sh --loop 15m --log results.log
#
# Exit status: 0 if every TLD nameserver answered, 1 otherwise.

set -u

TLD_NS=(a.registrydns.co b.registrydns.co c.registrydns.co d.registrydns.co)
# Sample .co domains to ask the TLD about (NS query — authoritative, cheap).
SAMPLE_DOMAINS=(daily.co huggingface.co hinge.co g.co t.co)
# Public resolvers for an end-to-end sanity check.
RESOLVERS=(1.1.1.1 8.8.8.8 9.9.9.9)
# AT&T / legacy-BellSouth southeast US resolvers. The user is on AT&T and we
# suspect their ISP DNS may be using Cloudflare upstream — probing these
# directly tells us whether AT&T's own caches are returning .co answers.
# 68.94.156.1/157.1 are the national AT&T residential pair; the 205.152.*
# addresses are legacy BellSouth caches still serving GA / FL / LA-MS-TN.
ATT_RESOLVERS=(
    68.94.156.1       # AT&T residential primary (national)
    68.94.157.1       # AT&T residential secondary (national)
    205.152.37.23     # BellSouth/ATT-SE — Georgia
    205.152.144.23    # BellSouth/ATT-SE — Georgia alt
    205.152.132.23    # BellSouth/ATT-SE — LA/MS/TN
)
# Control: a non-.co domain through the same resolvers.
CONTROL_DOMAIN=example.com

TIMEOUT=3
TRIES=1

LOG=""
LOOP_INTERVAL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --loop) LOOP_INTERVAL="$2"; shift 2 ;;
        --log)  LOG="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

log() {
    if [[ -n "$LOG" ]]; then
        printf '%s\n' "$*" | tee -a "$LOG"
    else
        printf '%s\n' "$*"
    fi
}

# Query $1 (server) for NS of $2 (domain). Echoes one of:
#   OK <ms> <answer-count>
#   FAIL <reason>
probe() {
    local server="$1" domain="$2"
    local start end ms out status
    start=$(date +%s%3N)
    out=$(dig +tries=$TRIES +time=$TIMEOUT +noall +answer +authority +comments \
              "@${server}" "${domain}" NS 2>&1)
    status=$?
    end=$(date +%s%3N)
    ms=$((end - start))

    if [[ $status -ne 0 ]]; then
        echo "FAIL exit=$status ${ms}ms"
        return 1
    fi
    if grep -q 'connection timed out' <<<"$out"; then
        echo "FAIL timeout ${ms}ms"
        return 1
    fi
    local rcode
    rcode=$(grep -oE 'status: [A-Z]+' <<<"$out" | head -1 | awk '{print $2}')
    if [[ "$rcode" != "NOERROR" && -n "$rcode" ]]; then
        echo "FAIL rcode=$rcode ${ms}ms"
        return 1
    fi
    # Count NS records mentioning the domain in either ANSWER or AUTHORITY.
    # TLD servers reply with a referral (NS in AUTHORITY); recursive
    # resolvers put the NS records in ANSWER.
    local ns_count
    ns_count=$(grep -cE "^${domain}\.[[:space:]]+[0-9]+[[:space:]]+IN[[:space:]]+NS" <<<"$out")
    echo "OK ${ms}ms ns=${ns_count}"
    return 0
}

run_once() {
    local ts failures=0
    ts=$(date -Iseconds)
    log ""
    log "=== ${ts} ==="

    log "-- .co TLD authoritative nameservers --"
    for ns in "${TLD_NS[@]}"; do
        for dom in "${SAMPLE_DOMAINS[@]}"; do
            local result
            result=$(probe "$ns" "$dom")
            log "  ${ns} ${dom} ${result}"
            [[ "$result" == OK* ]] || failures=$((failures+1))
        done
    done

    log "-- Public resolvers (end-to-end NS lookup) --"
    for r in "${RESOLVERS[@]}"; do
        for dom in "${SAMPLE_DOMAINS[@]}"; do
            local result
            result=$(probe "$r" "$dom")
            log "  ${r} ${dom} ${result}"
        done
        # control
        local cresult
        cresult=$(probe "$r" "$CONTROL_DOMAIN")
        log "  ${r} ${CONTROL_DOMAIN} ${cresult}    [control]"
    done

    log "-- AT&T / BellSouth southeast resolvers --"
    for r in "${ATT_RESOLVERS[@]}"; do
        for dom in "${SAMPLE_DOMAINS[@]}"; do
            local result
            result=$(probe "$r" "$dom")
            log "  ${r} ${dom} ${result}"
        done
        local cresult
        cresult=$(probe "$r" "$CONTROL_DOMAIN")
        log "  ${r} ${CONTROL_DOMAIN} ${cresult}    [control]"
    done

    log "-- Summary: ${failures} TLD-nameserver failure(s) this run --"
    return $(( failures > 0 ? 1 : 0 ))
}

# Convert "5m" / "30s" / "1h" to seconds.
to_seconds() {
    local s="$1"
    case "$s" in
        *s) echo "${s%s}" ;;
        *m) echo $(( ${s%m} * 60 )) ;;
        *h) echo $(( ${s%h} * 3600 )) ;;
        *)  echo "$s" ;;
    esac
}

if [[ -z "$LOOP_INTERVAL" ]]; then
    run_once
    exit $?
fi

SECS=$(to_seconds "$LOOP_INTERVAL")
log "# Looping every ${SECS}s. Ctrl-C to stop."
while true; do
    run_once || true
    sleep "$SECS"
done
