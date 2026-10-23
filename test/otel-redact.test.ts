import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

import { redactHttpSpan, traceSpan } from "../src/otel-init.js";
import { registerSecretUrl, resetSecretUrls } from "../src/redact.js";

// Spans leave the process (OTLP to the collector), so the RPC key must not be
// in an exception event, a span status or an HTTP span attribute.
const RPC = "https://rpc.example.com/v2/SECRETKEY123";
const exporter = new InMemorySpanExporter();
let prevEnabled: string | undefined;

beforeAll(() => {
  prevEnabled = process.env.OTEL_ENABLED;
  process.env.OTEL_ENABLED = "true";
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
  registerSecretUrl(RPC);
});

afterAll(() => {
  if (prevEnabled === undefined) delete process.env.OTEL_ENABLED;
  else process.env.OTEL_ENABLED = prevEnabled;
  resetSecretUrls();
});

describe("traceSpan", () => {
  test("a failing span records no RPC URL or key in its exception or status", async () => {
    const err = new Error(`HTTP request failed.\n\nURL: ${RPC}\nDetails: fetch failed`);
    await expect(traceSpan("reporter.test", async () => { throw err; })).rejects.toBe(err);
    const span = exporter.getFinishedSpans().find((s) => s.name === "reporter.test")!;
    expect(span).toBeDefined();
    const exported = JSON.stringify({ status: span.status, events: span.events, attributes: span.attributes });
    expect(exported).not.toContain("SECRETKEY123");
    expect(exported).toContain("rpc.example.com");
  });
});

describe("redactHttpSpan (undici requestHook)", () => {
  test("overwrites url.full, url.path and url.query for the RPC request", () => {
    const attrs: Record<string, unknown> = {};
    const span = { setAttribute: (k: string, v: unknown) => { attrs[k] = v; } };
    redactHttpSpan(span as never, { origin: "https://rpc.example.com", path: "/v2/SECRETKEY123?x=1" } as never);
    expect(JSON.stringify(attrs)).not.toContain("SECRETKEY123");
    expect(attrs["url.full"]).toBeDefined();
  });

  test("leaves a non-secret URL readable", () => {
    const attrs: Record<string, unknown> = {};
    const span = { setAttribute: (k: string, v: unknown) => { attrs[k] = v; } };
    redactHttpSpan(span as never, { origin: "https://api.example.org", path: "/markets?open=1" } as never);
    expect(attrs["url.full"]).toBe("https://api.example.org/markets?open=1");
  });
});
