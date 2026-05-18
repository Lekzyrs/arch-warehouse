import { collectDefaultMetrics, Registry } from "prom-client";

// Module-level singleton — never construct inside a request handler
// (duplicate-registration error). Phase 1: default process metrics only.
export const registry = new Registry();
registry.setDefaultLabels({ application: "stock-service" });
collectDefaultMetrics({ register: registry });

// Phase 3+/Phase 5+: add domain Counters/Histograms referencing METRIC_NAMES.
