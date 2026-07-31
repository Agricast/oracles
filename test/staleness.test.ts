import { describe, expect, test, beforeEach, afterEach, setSystemTime } from "bun:test";

import { readFileSync } from "node:fs";

import {
  assertSaneChainAgeSeconds,
  computeStalenessBound,
  describeStalenessBound,
  getStalenessBound,
  refreshStalenessBound,
  resetLastKnownChainValue,
  resetStalenessBoundCache,
  setMaxSourceDateAgeReader,
  MAX_SOURCE_DATE_AGE_FN,
  type StalenessBound,
} from "../src/staleness.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { toScaledPrice, StalePriceError } from "../src/price-source.js";
import AgriOracleAbi from "../src/abi/AgriOracle.json" with { type: "json" };

const HOUR = 3_600_000;
const MINUTE = 60_000;

// staleness.ts subtracts this from the chain value to get the enforced ceiling,
// so the node does not sign a price that is inside the bound at signing time and
// outside it by inclusion time.
const SUBMIT_MARGIN = 5 * MINUTE;

// staleness.ts MAX_CONSECUTIVE_FAILURES_BEFORE_EXPIRY. One read attempt per
// reporting cycle, so at the default POLL_INTERVAL_MS of 30s this is ~5 minutes
// of sustained failure before the remembered chain value is discarded.
const FAILURES_BEFORE_EXPIRY = 10;

// The live value on the deployed diamond, verified with
//   cast call 0xEd6eDf5C44fDD21a4D1073fCcF4eC3C22525BE62 "MAX_SOURCE_DATE_AGE()(uint256)"
// which returns 259200 (72h).
const CHAIN_72H_SECONDS = 259_200n;

// The outage this change was written for: MOC published nothing over the
// 2026-07-28..2026-07-31 holiday cluster, so the newest row is dated 07-27.
// Pinned "now" puts that price at exactly 100h old, matching the production log.
const NOW = new Date("2026-07-31T04:00:00Z");
const PRICE_DATE_2026_07_27 = "2026-07-27T00:00:00Z";

function quote(date: string) {
  return { productCode: "P14001", priceMin: 12.5, priceMax: 13.1, date };
}

function setBaseEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    REPORTER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: "31337",
    NETWORK: "local",
    ORACLE_ADDRESS: "0xEd6eDf5C44fDD21a4D1073fCcF4eC3C22525BE62",
    STALE_PRICE_HOURS: undefined,
    STALENESS_BOUND_TTL_MS: undefined,
    POLL_INTERVAL_MS: undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  resetStalenessBoundCache();
}

describe("computeStalenessBound", () => {
  test("the on-chain value governs when STALE_PRICE_HOURS is left at its default", () => {
    const bound = computeStalenessBound({
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: 72 * HOUR,
    });

    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.source).toBe("chain");
    expect(bound.ceilingSource).toBe("chain");
    expect(bound.clamped).toBe(false);
  });

  test("an explicit STALE_PRICE_HOURS tightens below the chain", () => {
    const bound = computeStalenessBound({
      localMs: 24 * HOUR,
      localExplicit: true,
      chainMs: 72 * HOUR,
    });

    expect(bound.effectiveMs).toBe(24 * HOUR);
    expect(bound.source).toBe("local-override");
    expect(bound.clamped).toBe(false);
  });

  test("an explicit STALE_PRICE_HOURS cannot loosen past the chain - it is clamped", () => {
    const bound = computeStalenessBound({
      localMs: 240 * HOUR,
      localExplicit: true,
      chainMs: 72 * HOUR,
    });

    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.source).toBe("chain");
    expect(bound.clamped).toBe(true);
    // The whole point: a looser local value must not turn a free local skip into
    // a paid on-chain revert.
    expect(bound.effectiveMs).toBeLessThan(bound.localMs);
  });

  // HIGH-1. The clamp used to evaporate on the failure path: a failed read
  // returned localMs unconditionally, so STALE_PRICE_HOURS=240 got the full 240h
  // the instant an RPC hiccupped, and the node would sign a 100h-old price
  // against a contract enforcing 72h.
  test("a looser local override stays clamped even when the chain read fails", () => {
    const bound = computeStalenessBound({
      localMs: 240 * HOUR,
      localExplicit: true,
      chainMs: null,
      lastKnownChainMs: 72 * HOUR,
      chainError: "HTTP request failed",
    });

    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.clamped).toBe(true);
    expect(bound.ceilingSource).toBe("last-known-chain");
    expect(bound.effectiveMs).toBeLessThan(bound.localMs);
  });

  test("with no successful read ever, the ceiling is the contract's own default", () => {
    const bound = computeStalenessBound({
      localMs: 240 * HOUR,
      localExplicit: true,
      chainMs: null,
      lastKnownChainMs: null,
      chainError: "HTTP request failed",
    });

    // OracleConstants.MAX_SOURCE_DATE_AGE = 3 days.
    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.ceilingSource).toBe("contract-default");
    expect(bound.clamped).toBe(true);
  });

  test("a failed read keeps a tighter local value applying", () => {
    const bound = computeStalenessBound({
      localMs: 24 * HOUR,
      localExplicit: true,
      chainMs: null,
      lastKnownChainMs: 72 * HOUR,
      chainError: "HTTP request failed",
    });

    expect(bound.effectiveMs).toBe(24 * HOUR);
    expect(bound.source).toBe("local-override");
    expect(bound.chainError).toBe("HTTP request failed");
  });

  // MEDIUM-1. The node checks at signing time, the contract at inclusion time.
  test("the enforced ceiling sits a submit margin under the chain value", () => {
    const bound = computeStalenessBound({ localMs: 48 * HOUR, localExplicit: false, chainMs: 72 * HOUR });

    expect(bound.ceilingMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.effectiveMs).toBeLessThan(72 * HOUR);
  });

  test("the description names both bounds, the margin, and which one won", () => {
    const chainWins = describeStalenessBound(
      computeStalenessBound({ localMs: 48 * HOUR, localExplicit: false, chainMs: 72 * HOUR }),
    );
    expect(chainWins).toContain("MAX_SOURCE_DATE_AGE=72h");
    expect(chainWins).toContain("STALE_PRICE_HOURS=48h");
    expect(chainWins).toContain("submit margin");

    const readFailed = describeStalenessBound(
      computeStalenessBound({
        localMs: 48 * HOUR,
        localExplicit: false,
        chainMs: null,
        lastKnownChainMs: 72 * HOUR,
        chainError: "boom",
      }),
    );
    // Must not read as a live value when it is not one.
    expect(readFailed).toContain("live read FAILED");
    expect(readFailed).toContain("boom");
    expect(readFailed).toContain("last known");
  });
});

describe("assertSaneChainAgeSeconds", () => {
  test("accepts the live on-chain value", () => {
    expect(assertSaneChainAgeSeconds(CHAIN_72H_SECONDS)).toBe(CHAIN_72H_SECONDS);
  });

  // LOW-1: the band mirrors the contract's own governance bounds, so a value the
  // setter would have rejected is not silently obeyed here.
  // OracleConstants.MIN_SOURCE_DATE_AGE = 1 hours, MAX_SOURCE_DATE_AGE_LIMIT = 30 days.
  test("mirrors the contract's settable range exactly", () => {
    expect(assertSaneChainAgeSeconds(3600n)).toBe(3600n);
    expect(assertSaneChainAgeSeconds(30n * 24n * 3600n)).toBe(30n * 24n * 3600n);
    expect(() => assertSaneChainAgeSeconds(3599n)).toThrow(/outside the sane range/);
    expect(() => assertSaneChainAgeSeconds(30n * 24n * 3600n + 1n)).toThrow(/outside the sane range/);
  });

  test("rejects zero and absurd values rather than obeying them", () => {
    expect(() => assertSaneChainAgeSeconds(0n)).toThrow(/outside the sane range/);
    expect(() => assertSaneChainAgeSeconds(400n * 24n * 3600n)).toThrow(/outside the sane range/);
    expect(() => assertSaneChainAgeSeconds(259_200)).toThrow(/expected a uint256/);
  });
});

// LOW-5. Every chain-path test swaps the whole reader, so the real read is never
// executed and a typo in the function name would leave all of them green while
// the node fails against a live diamond.
describe("the on-chain read wiring", () => {
  test("the ABI carries the exact view the reader asks for", () => {
    const abi = AgriOracleAbi as Array<{
      type: string;
      name?: string;
      inputs?: unknown[];
      outputs?: Array<{ type: string }>;
      stateMutability?: string;
    }>;
    const entry = abi.find((i) => i.type === "function" && i.name === MAX_SOURCE_DATE_AGE_FN);

    expect(entry).toBeDefined();
    expect(entry!.inputs).toHaveLength(0);
    expect(entry!.stateMutability).toBe("view");
    expect(entry!.outputs).toHaveLength(1);
    expect(entry!.outputs![0]!.type).toBe("uint256");
  });

  // MEDIUM-2. Both are decodable from the ABI, so classifyRevert sees a name
  // rather than an undecodable blob - which is what made them fall through to
  // "unknown" and abort the whole cycle before this change.
  test("the sourceDate reverts are decodable errors in the ABI", () => {
    const errors = (AgriOracleAbi as Array<{ type: string; name?: string }>)
      .filter((i) => i.type === "error")
      .map((i) => i.name);

    expect(errors).toContain("SourceDateTooOld");
    expect(errors).toContain("SourceDateInFuture");
  });
});

// LOW-6. My earlier commit message claimed the tests covered the per-cycle
// re-read; they covered refreshStalenessBound() in isolation. Nothing asserted
// runCycle calls it, or calls it before discovering markets, so deleting that
// line would have left the suite green while per-process caching came back.
// A unit test cannot reach runCycle without a wallet, an RPC and otel, so this
// is a static guard in the same spirit as backend CI's admin-auth guard count.
describe("runCycle ordering (static guard)", () => {
  const source = readFileSync(new URL("../src/reporter.ts", import.meta.url), "utf8");

  test("the staleness bound is refreshed before markets are discovered", () => {
    const refresh = source.indexOf("await refreshStalenessBound()");
    const discover = source.indexOf("await discoverReportableMarkets()");

    expect(refresh).toBeGreaterThan(-1);
    expect(discover).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(discover);
  });

  test("the resolved bound is threaded into every market rather than re-fetched", () => {
    expect(source).toContain("submitReportForMarket(clients, market, bound)");
    // price-source must not resolve its own bound - that is what let one cycle
    // judge different markets against different windows.
    const priceSource = readFileSync(new URL("../src/price-source.ts", import.meta.url), "utf8");
    expect(priceSource).not.toContain("getStalenessBound(");
  });
});

describe("getStalenessBound", () => {
  const originalError = console.error;

  beforeEach(() => {
    resetLastKnownChainValue();
  });

  afterEach(() => {
    console.error = originalError;
    setMaxSourceDateAgeReader(null);
    resetLastKnownChainValue();
  });

  test("honours the value read off the chain", async () => {
    setBaseEnv();
    setMaxSourceDateAgeReader(async () => CHAIN_72H_SECONDS);

    const bound = await getStalenessBound();

    expect(bound.chainMs).toBe(72 * HOUR);
    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.source).toBe("chain");
  });

  test("a local override tightens the chain value", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "24" });
    setMaxSourceDateAgeReader(async () => CHAIN_72H_SECONDS);

    const bound = await getStalenessBound();

    expect(loadConfig().staleThresholdExplicit).toBe(true);
    expect(bound.effectiveMs).toBe(24 * HOUR);
    expect(bound.source).toBe("local-override");
  });

  test("a local override looser than the chain is clamped back", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "240" });
    setMaxSourceDateAgeReader(async () => CHAIN_72H_SECONDS);

    const bound = await getStalenessBound();

    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.clamped).toBe(true);
  });

  test("a failed chain read holds the contract-default ceiling and logs the failure", async () => {
    setBaseEnv();
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    setMaxSourceDateAgeReader(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
    });

    const bound = await getStalenessBound();

    expect(bound.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(bound.source).toBe("fallback");
    expect(bound.ceilingSource).toBe("contract-default");
    // A bad RPC has to look like a bad RPC, not like a stale price.
    expect(logged.join("\n")).toContain("ECONNREFUSED");
    expect(logged.join("\n")).toContain("MAX_SOURCE_DATE_AGE");
    expect(logged.join("\n")).toContain("not a stale price");
  });

  // HIGH-1 end to end, through the real cache and last-known retention.
  // A brief blip must NOT throw away a widened limit - that is the Thai-holiday
  // case the whole module exists for.
  test("a short run of read failures keeps clamping to the last known value", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "240" });
    let onChain: bigint | null = 10n * 24n * 3600n; // operator widened to 10 days
    console.error = () => {};
    setMaxSourceDateAgeReader(async () => {
      if (onChain === null) throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      return onChain;
    });

    expect((await refreshStalenessBound()).effectiveMs).toBe(240 * HOUR - SUBMIT_MARGIN);

    onChain = null; // RPC falls over
    const afterFailure = await refreshStalenessBound();

    expect(afterFailure.ceilingSource).toBe("last-known-chain");
    expect(afterFailure.effectiveMs).toBe(240 * HOUR - SUBMIT_MARGIN);
    // Still clamped - the local 240h never becomes the bound on its own.
    expect(afterFailure.clamped).toBe(true);
  });

  // F1. Holding the remembered value forever means that if governance TIGHTENS
  // while the RPC is down, the node sits looser than the chain and pays reverts
  // until the RPC returns. After a sustained run of failures the memory expires
  // and the ceiling converges on the contract default.
  test("the remembered value expires after a sustained run of failures", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "240" });
    let onChain: bigint | null = 10n * 24n * 3600n;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    setMaxSourceDateAgeReader(async () => {
      if (onChain === null) throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      return onChain;
    });

    await refreshStalenessBound();
    onChain = null;

    // Failures 1..9 keep the widened value.
    for (let i = 1; i < FAILURES_BEFORE_EXPIRY; i += 1) {
      const bound = await refreshStalenessBound();
      expect(bound.ceilingSource).toBe("last-known-chain");
      expect(bound.effectiveMs).toBe(240 * HOUR - SUBMIT_MARGIN);
    }

    // The 10th drops it to the contract default.
    const expired = await refreshStalenessBound();
    expect(expired.ceilingSource).toBe("contract-default");
    expect(expired.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(expired.clamped).toBe(true);
    expect(logged.join("\n")).toContain("EXPIRED");

    // It stays expired while the outage continues, and never falls back to the
    // local 240h under any condition.
    const stillDown = await refreshStalenessBound();
    expect(stillDown.ceilingSource).toBe("contract-default");
    expect(stillDown.effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
  });

  test("one successful read resets the failure run", async () => {
    setBaseEnv();
    let onChain: bigint | null = 10n * 24n * 3600n;
    console.error = () => {};
    setMaxSourceDateAgeReader(async () => {
      if (onChain === null) throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      return onChain;
    });

    await refreshStalenessBound();

    // Nine failures, then the RPC comes back.
    onChain = null;
    for (let i = 1; i < FAILURES_BEFORE_EXPIRY; i += 1) await refreshStalenessBound();
    onChain = 10n * 24n * 3600n;
    expect((await refreshStalenessBound()).ceilingSource).toBe("chain");

    // The counter restarted, so the next nine failures must not expire it.
    onChain = null;
    for (let i = 1; i < FAILURES_BEFORE_EXPIRY; i += 1) {
      expect((await refreshStalenessBound()).ceilingSource).toBe("last-known-chain");
    }
  });

  test("the chain value is re-read, never cached for the process lifetime", async () => {
    setBaseEnv({ STALENESS_BOUND_TTL_MS: "60000" });
    let reads = 0;
    let onChain = CHAIN_72H_SECONDS;
    setMaxSourceDateAgeReader(async () => {
      reads += 1;
      return onChain;
    });

    expect((await getStalenessBound()).effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    // Within the TTL, a second caller reuses the read rather than doing one
    // eth_call per market.
    expect((await getStalenessBound()).effectiveMs).toBe(72 * HOUR - SUBMIT_MARGIN);
    expect(reads).toBe(1);

    // An operator widens the limit to end an outage. No restart.
    onChain = 10n * 24n * 3600n;
    expect((await refreshStalenessBound()).effectiveMs).toBe(240 * HOUR - SUBMIT_MARGIN);
    expect(reads).toBe(2);
  });

  // LOW-8: the TTL expiring by elapsed time, not just by an explicit refresh.
  test("the cache expires on its own once the TTL has elapsed", async () => {
    setBaseEnv({ STALENESS_BOUND_TTL_MS: "30000" });
    let reads = 0;
    setMaxSourceDateAgeReader(async () => {
      reads += 1;
      return CHAIN_72H_SECONDS;
    });

    setSystemTime(NOW);
    await getStalenessBound();
    await getStalenessBound();
    expect(reads).toBe(1);

    setSystemTime(new Date(NOW.getTime() + 31_000));
    await getStalenessBound();
    expect(reads).toBe(2);

    setSystemTime();
  });
});

describe("the 2026-07-27 price, before and after", () => {
  beforeEach(() => {
    setSystemTime(NOW);
  });

  afterEach(() => {
    setSystemTime();
  });

  test("the price really is 100h old at the pinned time", () => {
    const ageMs = Date.now() - new Date(PRICE_DATE_2026_07_27).getTime();
    expect(ageMs / HOUR).toBe(100);
  });

  test("old behaviour: a bare 48h local bound skips it, naming only STALE_PRICE_HOURS", () => {
    // What the node did before this change - the local 48h was the whole story.
    const oldBound: StalenessBound = {
      effectiveMs: 48 * HOUR,
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: null,
      source: "fallback",
      clamped: false,
      ceilingMs: 48 * HOUR,
      ceilingSource: "contract-default",
    };

    expect(() => toScaledPrice(quote(PRICE_DATE_2026_07_27), oldBound)).toThrow(StalePriceError);
  });

  test("new behaviour: still skipped at 72h, but the message names the chain bound", () => {
    const bound = computeStalenessBound({
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: 72 * HOUR,
    });

    let message = "";
    try {
      toScaledPrice(quote(PRICE_DATE_2026_07_27), bound);
      throw new Error("expected a StalePriceError");
    } catch (err) {
      expect(err).toBeInstanceOf(StalePriceError);
      message = (err as Error).message;
    }

    expect(message).toContain("100h old");
    expect(message).toContain("MAX_SOURCE_DATE_AGE=72h");
    expect(message).toContain("STALE_PRICE_HOURS=48h (default)");
    expect(message).toContain("submit margin");
  });

  // LOW-8: the boundary the whole change hinges on. The contract reverts when
  // `sourceDate + maxAge < block.timestamp` (OracleReportingFacet.sol), so an age
  // exactly equal to the bound is ACCEPTED, and the node must match that or it
  // skips a price the chain would have taken.
  test("toScaledPrice accepts an age exactly equal to a hand-built bound, matching the contract", () => {
    const ageMs = Date.now() - new Date(PRICE_DATE_2026_07_27).getTime();
    const exact: StalenessBound = {
      effectiveMs: ageMs,
      localMs: ageMs,
      localExplicit: true,
      chainMs: ageMs + SUBMIT_MARGIN,
      source: "local-override",
      clamped: false,
      ceilingMs: ageMs,
      ceilingSource: "chain",
    };

    expect(() => toScaledPrice(quote(PRICE_DATE_2026_07_27), exact)).not.toThrow();
  });

  test("toScaledPrice rejects one millisecond past a hand-built bound", () => {
    const ageMs = Date.now() - new Date(PRICE_DATE_2026_07_27).getTime();
    const justOver: StalenessBound = {
      effectiveMs: ageMs - 1,
      localMs: ageMs - 1,
      localExplicit: true,
      chainMs: ageMs + SUBMIT_MARGIN,
      source: "local-override",
      clamped: false,
      ceilingMs: ageMs - 1,
      ceilingSource: "chain",
    };

    expect(() => toScaledPrice(quote(PRICE_DATE_2026_07_27), justOver)).toThrow(StalePriceError);
  });

  test("widening the on-chain limit to 10 days flips the same price to accepted", async () => {
    setBaseEnv();
    resetLastKnownChainValue();
    setMaxSourceDateAgeReader(async () => 10n * 24n * 3600n);
    const bound = await getStalenessBound();
    setMaxSourceDateAgeReader(null);

    expect(bound.effectiveMs).toBe(240 * HOUR - SUBMIT_MARGIN);

    const scaled = toScaledPrice(quote(PRICE_DATE_2026_07_27), bound);

    expect(scaled.priceMin).toBe(12_500_000n);
    expect(scaled.priceMax).toBe(13_100_000n);
    expect(scaled.sourceDate).toBe(BigInt(new Date(PRICE_DATE_2026_07_27).getTime() / 1000));
  });

  test("a 48h local override still tightens, so the operator keeps the stricter policy", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "48" });
    resetLastKnownChainValue();
    setMaxSourceDateAgeReader(async () => 10n * 24n * 3600n);
    const bound = await getStalenessBound();
    setMaxSourceDateAgeReader(null);

    expect(bound.effectiveMs).toBe(48 * HOUR);
    expect(() => toScaledPrice(quote(PRICE_DATE_2026_07_27), bound)).toThrow(StalePriceError);
  });
});
