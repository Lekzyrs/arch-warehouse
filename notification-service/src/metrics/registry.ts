import { collectDefaultMetrics, Registry } from "prom-client";

// Module-level singleton — never construct inside a request handler
// (duplicate-registration error). Phase 1: default process metrics only.
export const registry = new Registry();
registry.setDefaultLabels({ application: "notification-service" });
collectDefaultMetrics({ register: registry });

// Phase 5+: add notification_events_consumed_total counter.
