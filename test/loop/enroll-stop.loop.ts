import { expect, test } from "bun:test";

import { clients, ctl, exits, sleep } from "./harness.js";

const { startReporterLoop } = await import("../../src/reporter.js");

test("no registerReporter tx once SIGTERM arrived mid-cycle", async () => {
  clients.config.autoEnroll = true;
  ctl.registered = false;
  ctl.blockDelay = 40;
  await startReporterLoop();
  await sleep(15); // cycle is in getBlockNumber, ensureEnrolled comes next
  process.emit("SIGTERM" as never);
  ctl.stopped = true;
  await sleep(80);
  ctl.receiptResolvers.shift()?.();
  await sleep(20);
  expect(ctl.writesAfterStop).toBe(0);
  expect(exits).toEqual([0]);
});
