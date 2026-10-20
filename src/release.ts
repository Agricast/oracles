import { hostname } from "node:os";

// Same base the backend uses (backend/src/lib/release.ts), so the deploy check
// "service.version = 1.0.0+<sha7>" reads the same for every service.
const BASE_VERSION = "1.0.0";

/** `1.0.0+<sha7>` from GIT_COMMIT, or `1.0.0+unknown` when it is unset or not a hex SHA. */
export function serviceVersion(gitCommit: string | undefined = process.env.GIT_COMMIT): string {
  const sha = (gitCommit ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? `${BASE_VERSION}+${sha.slice(0, 7)}` : `${BASE_VERSION}+unknown`;
}

/**
 * Per-process id for `service.instance.id`. Three reporters share one image and
 * one SHA, so the SHA cannot tell them apart; the container hostname can.
 * OTEL_SERVICE_INSTANCE_ID overrides it (e.g. "reporter-1").
 */
export function serviceInstanceId(
  override: string | undefined = process.env.OTEL_SERVICE_INSTANCE_ID,
  host: string = hostname(),
): string {
  return override?.trim() || host;
}
