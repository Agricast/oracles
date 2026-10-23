import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHeartbeat } from "../src/heartbeat.js";
import { serviceInstanceId, serviceVersion } from "../src/release.js";

describe("serviceVersion", () => {
  test("uses the first 7 chars of GIT_COMMIT", () => {
    expect(serviceVersion({ GIT_COMMIT: "ABCDEF0123456789abcdef0123456789abcdef01" })).toBe("1.0.0+abcdef0");
    expect(serviceVersion({ GIT_COMMIT: "  1234567 " })).toBe("1.0.0+1234567");
  });
  test("unset, empty or non-hex reads as unknown", () => {
    expect(serviceVersion({})).toBe("1.0.0+unknown");
    expect(serviceVersion({ GIT_COMMIT: "" })).toBe("1.0.0+unknown");
    expect(serviceVersion({ GIT_COMMIT: "not-a-sha" })).toBe("1.0.0+unknown");
    expect(serviceVersion({ GIT_COMMIT: "abc12" })).toBe("1.0.0+unknown");
  });
});

describe("serviceVersion fallbacks", () => {
  test("falls back to SOURCE_COMMIT then COOLIFY_GIT_COMMIT_SHA, treating empty as unset", () => {
    // compose passes GIT_COMMIT="" when the build arg is not set; Coolify still
    // injects SOURCE_COMMIT, so the version must come from there.
    expect(serviceVersion({ GIT_COMMIT: "", SOURCE_COMMIT: "abcdef0123" })).toBe("1.0.0+abcdef0");
    expect(serviceVersion({ GIT_COMMIT: "  ", COOLIFY_GIT_COMMIT_SHA: "1234567890" })).toBe("1.0.0+1234567");
    expect(serviceVersion({ GIT_COMMIT: "fedcba9", SOURCE_COMMIT: "abcdef0" })).toBe("1.0.0+fedcba9");
    expect(serviceVersion({ GIT_COMMIT: "", SOURCE_COMMIT: "" })).toBe("1.0.0+unknown");
    expect(serviceVersion({})).toBe("1.0.0+unknown");
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
