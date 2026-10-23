import { expect, test } from "bun:test";

import { ctl, exits, log, sleep } from "./harness.js";

const { startReporterLoop } = await import("../../src/reporter.js");

test("after SIGTERM the running cycle finishes the in-flight market and sends no new tx", async () => {
  ctl.markets = 3;
  await startReporterLoop();
  await sleep(30);
  expect(ctl.writes).toBe(1); // market 0 is waiting on its receipt
  process.emit("SIGTERM" as never);
  ctl.stopped = true;
  for (let i = 0; i < 3; i++) {
    await sleep(10);
    ctl.receiptResolvers.shift()?.();
  }
  await sleep(30);
  expect(log).toEqual(["cycle-start", "write", "receipt", "exit:0"]);
  expect(exits).toEqual([0]);
  expect(ctl.cyclesStarted).toBe(1);
  expect(ctl.writesAfterStop).toBe(0);
});
