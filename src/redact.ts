// The RPC URL of a hosted provider carries the API key in its path, query or
// userinfo, and this repo is public, so logs only ever show scheme + host.

/** `https://host[:port]` for a URL, without credentials, path or query. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<invalid url>";
  }
}

// Literal strings to scrub from every message, longest first, each with what
// replaces it. Filled from the configured RPC URL by registerSecretUrl().
let secrets: Array<[string, string]> = [];
const MIN_SECRET_PIECE = 8;

/**
 * Remembers a URL whose path, query and userinfo must never be logged, so
 * stripUrls() also catches pieces of it that no URL pattern can see (a URL
 * split across lines, a path quoted on its own, the query without its "?").
 */
export function registerSecretUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const parts = new Set<string>();
  if (u.pathname.length > 1) parts.add(u.pathname);
  // A key in the path shows up on its own too ("key <KEY> is invalid").
  for (const segment of u.pathname.split("/")) parts.add(segment);
  if (u.search.length > 1) parts.add(u.search.slice(1));
  for (const value of u.searchParams.values()) parts.add(value);
  if (u.username) parts.add(u.username);
  if (u.password) parts.add(u.password);
  for (const p of [...parts]) {
    try {
      parts.add(decodeURIComponent(p));
    } catch {
      // not percent-encoded, nothing to add
    }
  }
  const host = redactUrl(url);
  // The whole URL as it appears in JSON ("https:\/\/...") and percent-encoded
  // (upper- and lower-case escapes), each replaced by the same encoding of the host.
  const encoded = encodeURIComponent(url);
  const next: Array<[string, string]> = [
    [url, host],
    [url.replaceAll("/", "\\/"), host.replaceAll("/", "\\/")],
    [encoded, encodeURIComponent(host)],
    [encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), encodeURIComponent(host)],
  ];
  // Short pieces ("/rpc", "v2", a username like "user") would shred hostnames
  // and ordinary words; key material is longer than this.
  for (const p of parts) if (p.length >= MIN_SECRET_PIECE) next.push([p, "<redacted>"]);
  secrets = [...secrets, ...next].sort((a, b) => b[0].length - a[0].length);
}

/** For tests. */
export function resetSecretUrls(): void {
  secrets = [];
}

// Characters that commonly close a URL in prose or JSON. Kept after the
// redacted host so `"<url>",` still reads as `"<host>",`.
const TRAILING = /["'<>)\]},;.]+$/;

/** Replaces only the literal pieces of registered secret URLs; other URLs stay readable. */
export function scrubSecrets(message: string): string {
  let out = message;
  for (const [secret, replacement] of secrets) out = out.split(secret).join(replacement);
  return out;
}

/**
 * Redacts every URL in `message` (viem errors include "URL: ...") down to its
 * host, matching to the end of the whitespace-delimited token so a quote or
 * bracket inside the URL cannot cut the match short. Then scrubs any literal
 * piece of a registered secret URL.
 */
export function stripUrls(message: string): string {
  return scrubSecrets(message).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (token) => {
    const tail = token.match(TRAILING)?.[0] ?? "";
    const host = redactUrl(token.slice(0, token.length - tail.length));
    // Keep the closing punctuation only when it holds nothing but punctuation.
    return host + tail;
  });
}
