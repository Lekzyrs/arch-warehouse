-- Source: Postgres official image convention (hub.docker.com/_/postgres)
-- Runs ONCE on empty volume only (after `docker compose down -v`).
-- Idempotent by construction: \gexec runs CREATE DATABASE only if not exists.
-- D-06: one Postgres 16 container, separate logical DB per service
-- (product_db for product-service, stock_db for stock-service).
-- notification-service has NO database and no entry here.

SELECT 'CREATE DATABASE product_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'product_db')
\gexec

SELECT 'CREATE DATABASE stock_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'stock_db')
\gexec
