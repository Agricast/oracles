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
// Path segments and the username are often generic ("/rpc", "v2", "user") and
// would shred hostnames and words, so only long ones count. A password or a
// query value is a secret by definition and is scrubbed down to 4 chars;
// below that a replace-everywhere would mangle unrelated text.
const MIN_PATH_PIECE = 8;
const MIN_CREDENTIAL_PIECE = 4;
const SCHEME_WORDS = new Set(["http", "https", "ws", "wss"]);

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
  const pathParts = new Set<string>();
  const credentialParts = new Set<string>();
  if (u.pathname.length > 1) pathParts.add(u.pathname);
  // A key in the path shows up on its own too ("key <KEY> is invalid").
  for (const segment of u.pathname.split("/")) pathParts.add(segment);
  if (u.username) pathParts.add(u.username);
  if (u.search.length > 1) credentialParts.add(u.search.slice(1));
  for (const value of u.searchParams.values()) {
    credentialParts.add(value);
    credentialParts.add(encodeURIComponent(value));
  }
  // The value as written in the URL, before any decoding ("+" kept and as a space).
  for (const pair of u.search.slice(1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const raw = pair.slice(eq + 1);
    credentialParts.add(raw);
    credentialParts.add(raw.replaceAll("+", " "));
  }
  if (u.password) credentialParts.add(u.password);
  for (const set of [pathParts, credentialParts]) {
    for (const p of [...set]) {
      try {
        set.add(decodeURIComponent(p));
      } catch {
        // not percent-encoded, nothing to add
      }
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
  // A piece inside the scheme or host would be replaced inside the redacted
  // "https://host" stripUrls() leaves behind, breaking it (and, if run first,
  // breaking URL detection so the rest of the URL leaked).
  const keep = (p: string) => !host.includes(p) && !SCHEME_WORDS.has(p.toLowerCase());
  for (const p of pathParts) if (p.length >= MIN_PATH_PIECE && keep(p)) next.push([p, "<redacted>"]);
  for (const p of credentialParts) if (p.length >= MIN_CREDENTIAL_PIECE && keep(p)) next.push([p, "<redacted>"]);
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
export function scrubSecrets(message: string, onlyWithWhitespace = false): string {
  let out = message;
  for (const [secret, replacement] of secrets) {
    if (onlyWithWhitespace && !/\s/.test(secret)) continue;
    out = out.split(secret).join(replacement);
  }
  return out;
}

/**
 * Redacts every URL in `message` (viem errors include "URL: ...") down to its
 * host, matching to the end of the whitespace-delimited token so a quote or
 * bracket inside the URL cannot cut the match short. Then scrubs any literal
 * piece of a registered secret URL.
 */
export function stripUrls(message: string): string {
  // URLs first: scrubbing pieces first could turn a URL into text the pattern
  // no longer recognises, and whatever path was left then leaked.
  // Pieces that contain whitespace (a decoded %20 or +) would be cut by the
  // whitespace-delimited URL match, so they go first.
  const urlsRedacted = scrubSecrets(message, true).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (token) => {
    const tail = token.match(TRAILING)?.[0] ?? "";
    const host = redactUrl(token.slice(0, token.length - tail.length));
    // Keep the closing punctuation only when it holds nothing but punctuation.
    return host + tail;
  });
  return scrubSecrets(urlsRedacted);
}
