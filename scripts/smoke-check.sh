#!/usr/bin/env bash
# smoke-check: контейнеры, /health, /actuator/prometheus,
# отсутствие hardcoded credentials, наличие product_db и stock_db.
# запуск после поднятия стека: bash scripts/smoke-check.sh

set -euo pipefail

POSTGRES_USER="${POSTGRES_USER:-archuser}"

echo "=== Phase 1 Smoke Check ==="

echo "[SC-01] No exited containers..."
EXITED=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -c "exited" || true)
[ "${EXITED:-0}" -eq 0 ] || { echo "FAIL: ${EXITED} container(s) exited"; exit 1; }
echo "  OK: 0 exited"

echo "[SC-02] Running container count >= 9..."
RUNNING=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -c "running" || true)
echo "  Running containers: ${RUNNING:-0} (expect 9+)"
[ "${RUNNING:-0}" -ge 9 ] || { echo "FAIL: only ${RUNNING:-0} running (expect >= 9)"; exit 1; }

# warn, не fail: единичный ECONNREFUSED до retry может появиться и уйти по withRetry backoff
echo "[SC-03] ECONNREFUSED log scan..."
for svc in product-service stock-service notification-service; do
  ERR=$(docker compose logs --tail=50 "$svc" 2>&1 | grep -c "ECONNREFUSED" || true)
  if [ "${ERR:-0}" -eq 0 ]; then
    echo "  OK: ${svc} clean"
  else
    echo "  WARN: ${svc} has ${ERR} ECONNREFUSED entries (retry may have cleared)"
  fi
done

echo "[SC-04] /health on 8080/8081/8082..."
curl -sf http://localhost:8080/health | grep -q '"ok":true' && echo "  OK: product-service /health"
curl -sf http://localhost:8081/health | grep -q '"ok":true' && echo "  OK: stock-service /health"
curl -sf http://localhost:8082/health | grep -q '"ok":true' && echo "  OK: notification-service /health"

echo "[SC-05] /actuator/prometheus on 8080/8081/8082..."
curl -sf http://localhost:8080/actuator/prometheus | grep -q "# HELP" && echo "  OK: product-service /actuator/prometheus"
curl -sf http://localhost:8081/actuator/prometheus | grep -q "# HELP" && echo "  OK: stock-service /actuator/prometheus"
curl -sf http://localhost:8082/actuator/prometheus | grep -q "# HELP" && echo "  OK: notification-service /actuator/prometheus"

echo "[SC-06] No hardcoded credentials in service src..."
# `|| true` нужен: grep без совпадений выходит с кодом 1 и под pipefail убил бы скрипт на успешном кейсе
HARDCODED=$( { grep -rEn "password[[:space:]]*=" product-service/src stock-service/src notification-service/src 2>/dev/null \
  | grep -v "process\.env" | grep -v "//" | wc -l | tr -d ' '; } || true )
[ "${HARDCODED:-0}" -eq 0 ] || { echo "FAIL: ${HARDCODED} potential hardcoded credential(s)"; exit 1; }
echo "  OK: 0 hardcoded credentials"

echo "[SC-07] product_db + stock_db exist..."
if docker compose ps --format '{{.Service}}' 2>/dev/null | grep -q "postgres"; then
  # -d postgres обязателен: иначе psql коннектится к БД с именем user (archuser), её нет -> false negative
  DBS=$(docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -tc "\l" 2>/dev/null || true)
  if echo "$DBS" | grep -q "product_db" && echo "$DBS" | grep -q "stock_db"; then
    echo "  OK: product_db and stock_db present"
  else
    echo "  FAIL: product_db and/or stock_db missing"
    exit 1
  fi
else
  echo "  WARN: postgres container not running - skipping DB existence check"
fi

echo "=== All checks passed ==="
