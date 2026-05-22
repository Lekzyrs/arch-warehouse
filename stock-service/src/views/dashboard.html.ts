// server-rendered html для event store dashboard. без клиентских фреймворков,
// без build step. шаблонные литералы возвращают полный html-документ.

import type { StockAggregateState } from "../domain/eventSchemas";

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

// detail page row types. колонки совпадают с events/snapshots схемой из 03-01
export interface DetailEventRow {
  version: number;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
}

export interface SnapshotRow {
  version: number;
  state: unknown;
  created_at: Date;
}

// общий css один раз - index и detail страницы используют идентичный стиль,
// дублирование уезжает при добавлении третьей view
const CSS_STYLES = `
    body { font-family: monospace; margin: 24px; }
    table { border-collapse: collapse; margin-bottom: 24px; }
    th, td { padding: 6px 12px; border: 1px solid #ccc; text-align: left; vertical-align: top; }
    th { background: #f4f4f4; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { margin-bottom: 8px; }
    h2 { margin-top: 24px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
    dl { margin: 0; }
    dt { font-weight: bold; }
    dd { margin: 0 0 6px 16px; }
`;

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

// json-блок для payload/state. stringify с 2-space indent + escape тегов внутри pre
function formatJson(value: unknown): string {
  return htmlEscape(JSON.stringify(value, null, 2));
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
  <style>${CSS_STYLES}</style>
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

// detail page: events ascending + snapshots descending + folded state из loadAggregate.
// foldedState=null - агрегат не существует (нет событий и нет snapshot) либо
// loadAggregate упал; в обоих случаях рендерим empty-state, не 500
export function renderAggregatePage(
  id: string,
  events: DetailEventRow[],
  snapshots: SnapshotRow[],
  foldedState: StockAggregateState | null,
): string {
  const safeId = htmlEscape(id);

  const eventsRowsHtml = events
    .map((row) => {
      const type = htmlEscape(row.event_type);
      return `<tr>
    <td>${row.version}</td>
    <td>${type}</td>
    <td><pre>${formatJson(row.payload)}</pre></td>
    <td>${formatDate(row.occurred_at)}</td>
  </tr>`;
    })
    .join("\n");

  const snapshotRowsHtml = snapshots
    .map((row) => {
      return `<tr>
    <td>${row.version}</td>
    <td><pre>${formatJson(row.state)}</pre></td>
    <td>${formatDate(row.created_at)}</td>
  </tr>`;
    })
    .join("\n");

  const emptyEventsNote =
    events.length === 0
      ? `<p>No events for this aggregate.</p>`
      : "";

  const emptySnapshotsNote =
    snapshots.length === 0
      ? `<p>No snapshots yet.</p>`
      : "";

  // folded state блок: dl (definition list) если есть state, иначе плейсхолдер
  const foldedStateHtml =
    foldedState !== null
      ? `<dl>
    <dt>on_hand</dt><dd>${foldedState.on_hand}</dd>
    <dt>reserved</dt><dd>${foldedState.reserved}</dd>
    <dt>version</dt><dd>${foldedState.version}</dd>
  </dl>`
      : `<p>No events - aggregate state unavailable.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Aggregate ${safeId}</title>
  <style>${CSS_STYLES}</style>
</head>
<body>
  <p><a href="/dashboard">&larr; Back to Dashboard</a></p>
  <h1>Aggregate: ${safeId}</h1>

  <h2>Folded State (current)</h2>
  ${foldedStateHtml}

  <h2>Event Stream (${events.length} events)</h2>
  <table>
    <thead>
      <tr>
        <th>Version</th>
        <th>Event Type</th>
        <th>Payload</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
${eventsRowsHtml}
    </tbody>
  </table>
  ${emptyEventsNote}

  <h2>Snapshots (${snapshots.length} snapshots)</h2>
  <table>
    <thead>
      <tr>
        <th>Version</th>
        <th>State</th>
        <th>Created At</th>
      </tr>
    </thead>
    <tbody>
${snapshotRowsHtml}
    </tbody>
  </table>
  ${emptySnapshotsNote}
</body>
</html>`;
}
