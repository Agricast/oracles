import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHeartbeat } from "../src/heartbeat.js";
import { serviceInstanceId, serviceVersion } from "../src/release.js";

describe("serviceVersion", () => {
  test("uses the first 7 chars of GIT_COMMIT", () => {
    expect(serviceVersion("ABCDEF0123456789abcdef0123456789abcdef01")).toBe("1.0.0+abcdef0");
    expect(serviceVersion("  1234567 ")).toBe("1.0.0+1234567");
  });
  test("unset, empty or non-hex reads as unknown", () => {
    expect(serviceVersion(undefined)).toBe("1.0.0+unknown");
    expect(serviceVersion("")).toBe("1.0.0+unknown");
    expect(serviceVersion("not-a-sha")).toBe("1.0.0+unknown");
    expect(serviceVersion("abc12")).toBe("1.0.0+unknown");
  });
});

describe("serviceInstanceId", () => {
  test("override wins, hostname is the fallback", () => {
    expect(serviceInstanceId("reporter-2", "host-a")).toBe("reporter-2");
    expect(serviceInstanceId(undefined, "host-a")).toBe("host-a");
    expect(serviceInstanceId("  ", "host-a")).toBe("host-a");
  });
});

describe("writeHeartbeat", () => {
  test("creates the file and refreshes it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hb-")), "beat");
    writeHeartbeat(path);
    expect(existsSync(path)).toBe(true);
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(5_000);
  });
  test("does not throw when the path is unwritable", () => {
    expect(() => writeHeartbeat("/nonexistent-dir/beat")).not.toThrow();
  });
});
