-- запускается один раз на пустом volume (после docker compose down -v)
-- идемпотентно: \gexec делает CREATE DATABASE только если её нет
-- отдельная логическая БД на сервис (product_db, stock_db), у notification-service БД нет

SELECT 'CREATE DATABASE product_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'product_db')
\gexec

SELECT 'CREATE DATABASE stock_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'stock_db')
\gexec
