import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clients, ctl, sleep } from "./harness.js";

const HB = join(mkdtempSync(join(tmpdir(), "hb-loop-")), "beat");
process.env.HEARTBEAT_FILE = HB;

const { startReporterLoop } = await import("../../src/reporter.js");

test("heartbeat: not when inactive or when the cycle throws, yes when it ran with per-market failures", async () => {
  ctl.registered = false;
  ctl.markets = 1;
  await startReporterLoop();
  await sleep(30);
  expect(existsSync(HB)).toBe(false); // not registered -> not healthy

  ctl.registered = true;
  const realBlockNumber = clients.publicClient.getBlockNumber;
  clients.publicClient.getBlockNumber = async () => {
    throw new Error("rpc down");
  };
  await sleep(30);
  expect(existsSync(HB)).toBe(false); // cycle threw before markets

  clients.publicClient.getBlockNumber = realBlockNumber;
  ctl.failMarkets = true; // one market fails, the cycle itself completes
  await sleep(2_500); // first backoff step is 2s
  expect(existsSync(HB)).toBe(true);
});
