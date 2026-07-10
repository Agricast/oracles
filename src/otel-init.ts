import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  trace,
  metrics,
  context as apiContext,
  SpanStatusCode,
  type Tracer,
  type Histogram,
  type Counter,
} from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { logs, SeverityNumber, type Logger as OtelLogger } from "@opentelemetry/api-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

/**
 * Opt-in OTLP traces + logs + metrics for this standalone reporter, against
 * the same self-hosted SigNoz collector the backend points at
 * (backend/src/lib/otel.ts) - same env-var switch, keyless by default. This
 * service isn't an Elysia app so it can't reuse @elysiajs/opentelemetry; it
 * wires the Node SDK directly instead.
 *
 * Load this FIRST, before reporter.ts - via
 * `node --import ./dist/otel-init.js dist/reporter.js` (see Dockerfile CMD).
 * ESM module instances are cached per resolved URL, so reporter.ts importing
 * `tracer`/`traceSpan` from here afterwards gets the same already-initialized
 * instance, not a second one.
 *
 * Env:
 *   OTEL_ENABLED=true                 - explicit on/off switch
 *   OTEL_EXPORTER_OTLP_ENDPOINT=...    - collector base URL, e.g.
 *                                        http://localhost:4318 - a bare base,
 *                                        NOT a full /v1/traces path. Traces,
 *                                        logs, and metrics each append their
 *                                        own /v1/... path below (same
 *                                        convention backend/src/lib/otel.ts
 *                                        uses via its otlpBase() helper).
 *                                        Setting this without OTEL_ENABLED
 *                                        also turns things on (see
 *                                        isOtelEnabled below).
 *   OTEL_EXPORTER_OTLP_HEADERS=...     - comma-separated key=value pairs,
 *                                        e.g. "signoz-ingestion-key=xxx".
 *                                        Omit for a local collector with no
 *                                        auth - this deploy is keyless.
 *   OTEL_SERVICE_NAME=agricast-oracle-reporter - resource service.name
 *
 * Metrics: agricast.reporter.cycle.duration_ms (histogram, one poll-and-report
 * cycle's wall time) and agricast.reporter.reports_submitted (counter,
 * incremented once per successful on-chain submitReport) - agricast.* prefix
 * to match backend's instrument naming (agricast.order_match.duration_ms,
 * agricast.oracle.reports_submitted, etc). See the Metrics section below.
 *
 * Logs: reporter.ts and friends log via plain console.log/warn/error
 * prefixed "[reporter]" - rewriting every call site to a structured logger
 * wasn't worth it for one small service, so patchConsole() below wraps the
 * three console methods to also emit an OTel log record (with the active
 * span's trace/span id attached) alongside the original console output,
 * which keeps working unchanged.
 */

function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

export function isOtelEnabled(): boolean {
  const flag = (process.env.OTEL_ENABLED ?? "").trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  // Not explicitly set - infer from the presence of a collector endpoint, so
  // just pointing OTEL_EXPORTER_OTLP_ENDPOINT at a collector is enough.
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "agricast-oracle-reporter";

// Package version for the resource's service.version - read from disk rather
// than a static JSON import so this resolves the same way whether it's run
// from src/ (tsx) or dist/ (built): both sit one level under package.json.
function readServiceVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Exported unconditionally: trace.getTracer() returns a harmless no-op
// tracer when no provider is registered, so reporter.ts can always import
// and call `tracer.startActiveSpan` regardless of whether OTel is enabled.
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);

let otelLogger: OtelLogger | null = null;

/**
 * Wrap an async step in an OTel span - no-op (just runs fn) when OTel is
 * disabled, so a normal run never pays even no-op span/context-manager cost.
 */
export async function traceSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  if (!isOtelEnabled()) return fn();

  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      span.end();
    }
  });
}

// ============================================
// Metrics - two instruments covering the reporter's own on-chain activity,
// mirroring backend/src/lib/otel.ts's counter/histogram pattern. Cheap:
// instrument creation is idempotent per name, and every record/increment
// call below is a guarded no-op when tracing is off.
// ============================================

// Not created here (unlike the harmless no-op tracer above): metrics.getMeter()
// is eager, not a lazy proxy, so calling it before setGlobalMeterProvider()
// binds these permanently to the no-op meter and no metric ever reaches the
// exporter. Created inside initOtel() instead, right after the provider is
// registered - mirrors otelLogger's null-then-assign pattern above.
let cycleDurationMs: Histogram | null = null;
let reportsSubmittedCounter: Counter | null = null;

/** Record a reporter.cycle duration (ms). No-op when tracing is disabled. */
export function recordCycleDuration(
  ms: number,
  attributes: Record<string, string | number | boolean> = {},
): void {
  if (!isOtelEnabled()) return;
  cycleDurationMs?.record(ms, attributes);
}

/** Increment the reports-submitted counter. No-op when tracing is disabled. */
export function incrementReportsSubmitted(
  value = 1,
  attributes: Record<string, string | number | boolean> = {},
): void {
  if (!isOtelEnabled()) return;
  reportsSubmittedCounter?.add(value, attributes);
}

const CONSOLE_SEVERITY = {
  log: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
} as const;

function patchConsole(): void {
  for (const method of Object.keys(CONSOLE_SEVERITY) as (keyof typeof CONSOLE_SEVERITY)[]) {
    const original = console[method].bind(console);
    const { number, text } = CONSOLE_SEVERITY[method];
    console[method] = (...args: unknown[]) => {
      original(...args);
      otelLogger?.emit({
        severityNumber: number,
        severityText: text,
        body: args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
        // Pass the active context explicitly - the SDK only attaches
        // trace/span ids to a log record when a context is given, it does
        // not fall back to context.active() on its own.
        context: apiContext.active(),
      });
    };
  }
}

function initOtel(): void {
  if (!isOtelEnabled()) return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.warn(
      "[otel] OTEL_ENABLED is set but OTEL_EXPORTER_OTLP_ENDPOINT is missing - traces/logs stay disabled.",
    );
    return;
  }

  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const base = endpoint.replace(/\/+$/, "");
  const resource = resourceFromAttributes({
    "service.name": SERVICE_NAME,
    "service.version": readServiceVersion(),
    // Default to "production" (not "development") to match backend's
    // buildResource() - an unset NODE_ENV shouldn't split this service into
    // its own SigNoz environment away from everything else.
    "deployment.environment": process.env.NODE_ENV || "production",
    // New-semconv key, alongside the legacy one above - most current SigNoz
    // dashboards/collector configs still filter on "deployment.environment"
    // rather than this newer ".name" form, so both are set to the same
    // value (same convention backend/src/lib/otel.ts uses).
    "deployment.environment.name": process.env.NODE_ENV || "production",
    "service.instance.id": process.env.GIT_COMMIT || "unknown",
  });

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces`, headers })),
    ],
  });
  tracerProvider.register();

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs`, headers }) }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  otelLogger = logs.getLogger(SERVICE_NAME);

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }),
        exportIntervalMillis: 30_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const meter = metrics.getMeter(SERVICE_NAME);
  cycleDurationMs = meter.createHistogram("agricast.reporter.cycle.duration_ms", {
    description: "Duration of one reporter.cycle run (poll + report every reportable market)",
    unit: "ms",
  });
  reportsSubmittedCounter = meter.createCounter("agricast.reporter.reports_submitted", {
    description: "Count of price reports this reporter node successfully submitted on-chain",
  });

  // Covers both plain outbound fetch (price-source.ts, markets.ts) and
  // viem's http() transport, which also runs on Node's built-in fetch/undici
  // - one instrumentation gets both the price/markets API calls and the RPC
  // calls into SigNoz as child spans of whatever span is active.
  registerInstrumentations({ instrumentations: [new UndiciInstrumentation()] });

  patchConsole();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
    });
  }

  console.log(`[otel] traces+logs+metrics enabled -> ${base} (service=${SERVICE_NAME})`);
}

initOtel();
