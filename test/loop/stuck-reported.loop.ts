import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ctl, output, sleep } from "./harness.js";

const HB = join(mkdtempSync(join(tmpdir(), "hb-stuck-rep-")), "beat");
process.env.HEARTBEAT_FILE = HB;

const { startReporterLoop } = await import("../../src/reporter.js");

// Market P0 is already reported, so only P1 needed a report and it is blocked
// by the stuck tx. Counting P0 as "attempted" hid the alert and kept the
// heartbeat fresh while nothing could be reported.
test("stuck tx with one already-reported market still alerts and skips the heartbeat", async () => {
  ctl.markets = 2;
  ctl.latestNonce = 7;
  ctl.pendingNonce = 8;
  ctl.reportedIds = ["0x" + "0".repeat(64)];
  await startReporterLoop();
  await sleep(150);
  expect(ctl.cyclesStarted).toBeGreaterThan(1);
  expect(ctl.writes).toBe(0);
  expect(existsSync(HB)).toBe(false);
  expect(output.some((l) => l.includes("nonce 7") && l.includes("stuck"))).toBe(true);
});
