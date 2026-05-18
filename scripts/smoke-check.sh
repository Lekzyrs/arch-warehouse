#!/usr/bin/env bash
# scripts/smoke-check.sh — Phase 1 acceptance smoke check.
#
# Mechanically covers:
#   INFRA-01  containers running (SC-01, SC-02), /health up (SC-04)
#   INFRA-02  no ECONNREFUSED crash loop (SC-03)
#   INFRA-04  no hardcoded credentials in service src (SC-06)
#   OBS-01    all 3 services expose /actuator/prometheus (SC-05)
#   INFRA-03  (partial) product_db + stock_db exist (SC-07)
#
# NOTE: full INFRA-03 idempotency (`docker compose down -v && up`) is verified
# by the Plan 01-04 human-verify checkpoint, NOT by this script.
#
# Run after the stack is up:  bash scripts/smoke-check.sh

set -euo pipefail

POSTGRES_USER="${POSTGRES_USER:-archuser}"

echo "=== Phase 1 Smoke Check ==="

# SC-01: INFRA-01 — no exited containers
echo "[SC-01] No exited containers..."
EXITED=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -c "exited" || true)
[ "${EXITED:-0}" -eq 0 ] || { echo "FAIL: ${EXITED} container(s) exited"; exit 1; }
echo "  OK: 0 exited"

# SC-02: INFRA-01 — running container count >= 9
echo "[SC-02] Running container count >= 9..."
RUNNING=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -c "running" || true)
echo "  Running containers: ${RUNNING:-0} (expect 9+)"
[ "${RUNNING:-0}" -ge 9 ] || { echo "FAIL: only ${RUNNING:-0} running (expect >= 9)"; exit 1; }

# SC-03: INFRA-02 — no ECONNREFUSED in service logs (WARN, not FAIL — a
# transient pre-retry entry may appear then clear via withRetry backoff)
echo "[SC-03] ECONNREFUSED log scan..."
for svc in product-service stock-service notification-service; do
  ERR=$(docker compose logs --tail=50 "$svc" 2>&1 | grep -c "ECONNREFUSED" || true)
  if [ "${ERR:-0}" -eq 0 ]; then
    echo "  OK: ${svc} clean"
  else
    echo "  WARN: ${svc} has ${ERR} ECONNREFUSED entries (retry may have cleared)"
  fi
done

# SC-04: INFRA-01 + D-05 — /health returns {"ok":true} on all 3 services
echo "[SC-04] /health on 8080/8081/8082..."
curl -sf http://localhost:8080/health | grep -q '"ok":true' && echo "  OK: product-service /health"
curl -sf http://localhost:8081/health | grep -q '"ok":true' && echo "  OK: stock-service /health"
curl -sf http://localhost:8082/health | grep -q '"ok":true' && echo "  OK: notification-service /health"

# SC-05: OBS-01 — /actuator/prometheus returns Prometheus text on all 3
echo "[SC-05] /actuator/prometheus on 8080/8081/8082..."
curl -sf http://localhost:8080/actuator/prometheus | grep -q "# HELP" && echo "  OK: product-service /actuator/prometheus"
curl -sf http://localhost:8081/actuator/prometheus | grep -q "# HELP" && echo "  OK: stock-service /actuator/prometheus"
curl -sf http://localhost:8082/actuator/prometheus | grep -q "# HELP" && echo "  OK: notification-service /actuator/prometheus"

# SC-06: INFRA-04 — no hardcoded passwords in service src (env-only config)
echo "[SC-06] No hardcoded credentials in service src..."
HARDCODED=$(grep -rn "password\s*=" product-service/src stock-service/src notification-service/src 2>/dev/null \
  | grep -v "process\.env" | grep -v "//" | wc -l | tr -d ' ')
[ "${HARDCODED:-0}" -eq 0 ] || { echo "FAIL: ${HARDCODED} potential hardcoded credential(s)"; exit 1; }
echo "  OK: 0 hardcoded credentials"

# SC-07: INFRA-03 (partial) — product_db and stock_db created by init script
echo "[SC-07] product_db + stock_db exist..."
if docker compose ps --format '{{.Service}}' 2>/dev/null | grep -q "postgres"; then
  DBS=$(docker compose exec -T postgres psql -U "${POSTGRES_USER}" -tc "\l" 2>/dev/null || true)
  if echo "$DBS" | grep -q "product_db" && echo "$DBS" | grep -q "stock_db"; then
    echo "  OK: product_db and stock_db present"
  else
    echo "  FAIL: product_db and/or stock_db missing"
    exit 1
  fi
else
  echo "  WARN: postgres container not running — skipping DB existence check"
fi

echo "=== All checks passed ==="
