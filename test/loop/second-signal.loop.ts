import { expect, test } from "bun:test";

import { ctl, exits, output, sleep } from "./harness.js";

const { startReporterLoop } = await import("../../src/reporter.js");

// With process.once the first SIGTERM removed the only listener, so a second
// SIGTERM during the drain hit Node's default action and killed the process
// mid-transaction.
test("a second SIGTERM during the drain is still handled and does not exit early", async () => {
  ctl.markets = 1;
  await startReporterLoop();
  await sleep(30);
  process.emit("SIGTERM" as never);
  expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
  process.emit("SIGTERM" as never);
  await sleep(20);
  expect(exits).toEqual([]);
  expect(output.filter((l) => l.includes("already shutting down")).length).toBe(1);
  ctl.receiptResolvers.shift()!();
  await sleep(20);
  expect(exits).toEqual([0]);
});
