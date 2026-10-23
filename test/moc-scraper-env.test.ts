import { describe, expect, test } from "bun:test";

import { chromiumEnv } from "../src/moc-scraper.js";

// Chromium renders untrusted remote content; a renderer exploit must not find
// the reporter's key or RPC URL in its environment.
describe("chromiumEnv", () => {
  test("passes only what the browser needs, never secrets", () => {
    const env = chromiumEnv({
      PATH: "/usr/bin",
      HOME: "/home/reporter",
      TZ: "Asia/Bangkok",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      REPORTER_PRIVATE_KEY: "0xdeadbeef",
      RPC_URL: "https://rpc.example.com/v2/SECRETKEY123",
      OTEL_EXPORTER_OTLP_HEADERS: "signoz-ingestion-key=x",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/reporter",
      TZ: "Asia/Bangkok",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    });
  });
});
