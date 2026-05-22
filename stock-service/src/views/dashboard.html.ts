// server-rendered html для event store dashboard. без клиентских фреймворков,
// без build step. шаблонные литералы возвращают полный html-документ.

export interface AggregateRow {
  aggregate_id: string;
  last_event_type: string;
  event_count: number;
  last_version: number;
  last_event_time: Date;
}

export interface RecentEventRow {
  aggregate_id: string;
  version: number;
  event_type: string;
  occurred_at: Date;
}

// htmlEscape - минимальный экран для значений из бд. ключи, типы событий и uuid
// безопасны по схеме, но defensive escape убирает любой шанс инъекции html.
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value: Date | string): string {
  // pg отдаёт Date, но при ручной сборке row может прилететь string
  const d = value instanceof Date ? value : new Date(value);
  return htmlEscape(d.toISOString());
}

export function renderAggregateRow(row: AggregateRow): string {
  const id = htmlEscape(row.aggregate_id);
  const type = htmlEscape(row.last_event_type);
  return `<tr>
    <td><a href="/dashboard/aggregate/${id}">${id}</a></td>
    <td>${type}</td>
    <td>${row.event_count}</td>
    <td>${row.last_version}</td>
    <td>${formatDate(row.last_event_time)}</td>
  </tr>`;
}

export function renderEventRow(row: RecentEventRow): string {
  const id = htmlEscape(row.aggregate_id);
  const type = htmlEscape(row.event_type);
  return `<tr>
    <td><a href="/dashboard/aggregate/${id}">${id}</a></td>
    <td>${row.version}</td>
    <td>${type}</td>
    <td>${formatDate(row.occurred_at)}</td>
  </tr>`;
}

export function renderDashboard(
  aggregates: AggregateRow[],
  recentEvents: RecentEventRow[],
): string {
  const aggregateRowsHtml = aggregates.map(renderAggregateRow).join("\n");
  const recentRowsHtml = recentEvents.map(renderEventRow).join("\n");

  // empty state: уведомление выводится ниже первой таблицы, сама таблица всё
  // равно рендерится с заголовками - так структура страницы стабильна
  const emptyAggregatesNote =
    aggregates.length === 0
      ? `<p>No aggregates yet - send a stock command first.</p>`
      : "";

  const emptyEventsNote =
    recentEvents.length === 0
      ? `<p>No events yet.</p>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Event Store Dashboard</title>
  <style>
    body { font-family: monospace; margin: 24px; }
    table { border-collapse: collapse; margin-bottom: 24px; }
    th, td { padding: 6px 12px; border: 1px solid #ccc; text-align: left; }
    th { background: #f4f4f4; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { margin-bottom: 8px; }
    h2 { margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Event Store Dashboard</h1>

  <h2>Aggregates</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Type</th>
        <th>Events</th>
        <th>Last Version</th>
        <th>Last Event Time</th>
      </tr>
    </thead>
    <tbody>
${aggregateRowsHtml}
    </tbody>
  </table>
  ${emptyAggregatesNote}

  <h2>Recent Events (last 20)</h2>
  <table>
    <thead>
      <tr>
        <th>Aggregate ID</th>
        <th>Version</th>
        <th>Type</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
${recentRowsHtml}
    </tbody>
  </table>
  ${emptyEventsNote}
</body>
</html>`;
}
