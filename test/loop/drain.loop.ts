import { expect, test } from "bun:test";

import { ctl, exits, log, output, sleep } from "./harness.js";

const { startReporterLoop } = await import("../../src/reporter.js");

// Regression for the `stopping || cycleRunning` guard in tick(): ticks that
// fire while a cycle is in flight must not replace the promise SIGTERM drains.
test("SIGTERM during an in-flight cycle waits for it, then starts no new cycle", async () => {
  ctl.markets = 1;
  await startReporterLoop();
  await sleep(30); // cycle 1 is blocked on its receipt; several ticks fired meanwhile
  expect(ctl.cyclesStarted).toBe(1);
  expect(ctl.writes).toBe(1);
  process.emit("SIGTERM" as never);
  ctl.stopped = true;
  await sleep(100);
  expect(exits).toEqual([]); // still waiting on the tx
  ctl.receiptResolvers.shift()!();
  await sleep(20);
  expect(log).toEqual(["cycle-start", "write", "receipt", "exit:0"]);
  expect(exits).toEqual([0]);
  expect(ctl.cyclesStarted).toBe(1);
  expect(output.some((l) => l.includes("SIGTERM received"))).toBe(true);
});
