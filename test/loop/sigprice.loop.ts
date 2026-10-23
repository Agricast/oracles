import { expect, test } from "bun:test";

import { ctl, exits, sleep } from "./harness.js";

const { startReporterLoop } = await import("../../src/reporter.js");

// The market check in forEachIsolated runs before the market starts; a SIGTERM
// that lands during the (slow, Chromium) price fetch must still stop the send.
test("SIGTERM during a market's price fetch sends no submitReport", async () => {
  ctl.markets = 1;
  ctl.priceDelay = 60;
  await startReporterLoop();
  await sleep(15);
  expect(ctl.writes).toBe(0);
  process.emit("SIGTERM" as never);
  ctl.stopped = true;
  await sleep(120);
  ctl.receiptResolvers.shift()?.();
  await sleep(30);
  expect(ctl.writesAfterStop).toBe(0);
  expect(exits).toEqual([0]);
});
