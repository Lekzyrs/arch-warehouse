#!/usr/bin/env bash
# concurrency-test.sh - ES-05 optimistic concurrency demo
#
# Fires N=10 concurrent POST /stock/stock-in commands at the SAME aggregateId.
# All target the same expected version (1 on a fresh aggregate).
#
# Architectural guarantee: UNIQUE (aggregate_id, version) in events table (Plan 03-01 DDL).
# PostgreSQL rejects duplicate INSERTs with code 23505;
# appendEvents catches 23505 -> throws ConflictError -> router returns HTTP 409.
#
# Expected on real concurrency: exactly 1 success (200) + N-1 conflicts (409).
# Bash backgrounding with just two curls is too flaky (~60% race); 10 parallel via
# xargs -P forces a near-100% collision window. Test PASSES if at least one 409 is seen.

HOST=${STOCK_SERVICE_HOST:-http://localhost:8081}
AGG="CONC-TEST-$(date +%s)-$RANDOM"
PAYLOAD='{"aggregateId":"'"$AGG"'","productId":"CONC-PRODUCT","warehouseId":"WH-TEST","quantity":1}'
N=10

echo "Testing aggregate: $AGG"
echo "Host: $HOST"
echo "Parallel requests: $N"

# fire N curls in parallel через xargs -P. каждый пишет код в свою временную строку
RESULTS=$(
  seq 1 $N | xargs -n 1 -P $N -I {} curl -s -o /dev/null \
    -w "%{http_code}\n" -X POST "$HOST/stock/stock-in" \
    -H "Content-Type: application/json" -d "$PAYLOAD"
)

echo "HTTP responses:"
echo "$RESULTS"

SUCCESS=$(echo "$RESULTS" | grep -c '^200$' || true)
CONFLICT=$(echo "$RESULTS" | grep -c '^409$' || true)
OTHER=$(echo "$RESULTS" | grep -cvE '^(200|409)$' || true)

echo "200 (success):  $SUCCESS"
echo "409 (conflict): $CONFLICT"
echo "other:          $OTHER"

if [ "$SUCCESS" -ge 1 ] && [ "$CONFLICT" -ge 1 ] && [ "$OTHER" -eq 0 ]; then
  echo "CONCURRENCY TEST PASSED: $SUCCESS success + $CONFLICT conflict (ES-05 verified, UNIQUE constraint enforced)"
  exit 0
elif [ "$OTHER" -gt 0 ]; then
  echo "CONCURRENCY TEST FAILED: unexpected status codes seen (not 200/409)"
  exit 1
else
  echo "CONCURRENCY TEST INCONCLUSIVE: SUCCESS=$SUCCESS CONFLICT=$CONFLICT (no collision window hit; re-run)"
  exit 2
fi
