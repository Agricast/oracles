// Shared fake chain for the reporter-loop specs in this directory. Each spec
// runs in its own `bun test` process (see test/reporter-loop.test.ts) because
// reporter.ts keeps module-level loop state and these mocks replace whole
// modules, which would leak into every other test file in a shared process.
import { mock } from "bun:test";

export const log: string[] = [];
export const ctl: any = {
  markets: 3,
  registered: true,
  pendingNonce: 0,
  latestNonce: 0,
  failMarkets: false,
  receiptResolvers: [] as Array<() => void>,
  cyclesStarted: 0,
  writes: 0,
  writesAfterStop: 0,
  stopped: false,
};

const SRC = new URL("../../src/", import.meta.url).pathname;

mock.module(SRC + "config.ts", () => ({
  loadConfig: () => ({
    pollIntervalMs: 20,
    network: "test",
    chainId: 1,
    oracleAddress: "0x0000000000000000000000000000000000000001",
    autoEnroll: false,
    autoTopup: false,
  }),
  rpcTransport: () => null,
  assertOracleAddressHasCode: async () => {},
  resetConfigCache: () => {},
}));

export const clients: any = {
  account: { address: "0x00000000000000000000000000000000000000aa", signTypedData: async () => "0xsig" },
  config: { oracleAddress: "0x0000000000000000000000000000000000000001", chainId: 1, autoEnroll: false, autoTopup: false },
  publicClient: {
    getBlockNumber: async () => 1n,
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === "pending" ? ctl.pendingNonce : ctl.latestNonce,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getReporterInfo") return [ctl.registered, 10n, 0n, 0n, 0n];
      if (functionName === "ACTIVE_THRESHOLD") return 1n;
      if (functionName === "getQuestionReporters") {
        if (ctl.failMarkets) throw new Error("market read failed");
        return [];
      }
      return 0n;
    },
    waitForTransactionReceipt: () =>
      new Promise((r) => {
        ctl.receiptResolvers.push(() => {
          log.push("receipt");
          r({ status: "success" });
        });
      }),
  },
  walletClient: {
    chain: undefined,
    writeContract: async () => {
      ctl.writes++;
      if (ctl.stopped) ctl.writesAfterStop++;
      log.push("write");
      return "0xhash";
    },
  },
};

mock.module(SRC + "oracle.ts", () => ({ getOracleClients: async () => clients, AgriOracleAbi: [] }));
mock.module(SRC + "staleness.ts", () => ({
  refreshStalenessBound: async () => ({}),
  describeStalenessBound: () => "b",
}));
mock.module(SRC + "markets.ts", () => ({
  discoverReportableMarkets: async () => {
    ctl.cyclesStarted++;
    log.push("cycle-start");
    return Array.from({ length: ctl.markets }, (_, i) => ({
      productCode: "P" + i,
      questionId: "0x" + String(i).padStart(64, "0"),
    }));
  },
}));
mock.module(SRC + "price-source.ts", () => ({
  fetchScaledPrice: async () => ({ priceMin: 1n, priceMax: 2n, sourceDate: 1n }),
  StalePriceError: class extends Error {},
  ImplausiblePriceError: class extends Error {},
}));

export const exits: number[] = [];
(process as any).exit = (c: number) => {
  exits.push(c);
  log.push("exit:" + c);
};

// Captures console output so a spec can assert on what was logged.
export const output: string[] = [];
for (const level of ["log", "warn", "error"] as const) {
  const real = console[level];
  console[level] = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
    real(...args);
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
