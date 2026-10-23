import { expect, test } from "bun:test";

import { ctl, output, sleep } from "./harness.js";

const { startReporterLoop } = await import("../../src/reporter.js");

// A restart after a kill can leave a submitReport in the mempool that
// getQuestionReporters cannot see yet; sending again would pay a second bond.
test("no submitReport while the reporter account has a pending tx", async () => {
  ctl.markets = 2;
  ctl.pendingNonce = 5;
  ctl.latestNonce = 4;
  await startReporterLoop();
  await sleep(30);
  expect(ctl.writes).toBe(0);
  expect(output.some((l) => l.includes("still pending"))).toBe(true);
  ctl.pendingNonce = 4; // the old tx got mined
  await sleep(40);
  expect(ctl.writes).toBe(1);
});
