import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ctl, output, sleep } from "./harness.js";

const HB = join(mkdtempSync(join(tmpdir(), "hb-stuck-")), "beat");
process.env.HEARTBEAT_FILE = HB;

const { startReporterLoop } = await import("../../src/reporter.js");

// A tx stuck in the mempool makes every market skip, every cycle. That reporter
// reports nothing, so it must not keep a fresh heartbeat.
test("a stuck pending tx keeps the heartbeat stale and is logged with its nonce", async () => {
  ctl.markets = 2;
  ctl.latestNonce = 7;
  ctl.pendingNonce = 8;
  await startReporterLoop();
  await sleep(150);
  expect(ctl.cyclesStarted).toBeGreaterThan(1);
  expect(ctl.writes).toBe(0);
  expect(existsSync(HB)).toBe(false);
  expect(output.some((l) => l.includes("nonce 7") && l.includes("stuck"))).toBe(true);

  ctl.pendingNonce = 7; // mined or replaced; the next cycle submits both markets
  for (let i = 0; i < 6; i++) {
    await sleep(15);
    ctl.receiptResolvers.shift()?.();
  }
  expect(existsSync(HB)).toBe(true);
});
