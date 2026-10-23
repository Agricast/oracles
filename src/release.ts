import { hostname } from "node:os";

// Same base the backend uses (backend/src/lib/release.ts), so the deploy check
// "service.version = 1.0.0+<sha7>" reads the same for every service.
const BASE_VERSION = "1.0.0";

// Same order as the backend: our own build arg first, then what Coolify injects.
// compose passes GIT_COMMIT="" when the build arg is unset, so empty means unset.
const COMMIT_ENV_VARS = ["GIT_COMMIT", "SOURCE_COMMIT", "COOLIFY_GIT_COMMIT_SHA"] as const;

/** `1.0.0+<sha7>` from the first commit variable that holds a hex SHA, else `1.0.0+unknown`. */
export function serviceVersion(env: Record<string, string | undefined> = process.env): string {
  for (const name of COMMIT_ENV_VARS) {
    const sha = (env[name] ?? "").trim().toLowerCase();
    if (/^[0-9a-f]{7,40}$/.test(sha)) return `${BASE_VERSION}+${sha.slice(0, 7)}`;
  }
  return `${BASE_VERSION}+unknown`;
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
