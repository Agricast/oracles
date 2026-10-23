// The RPC URL of a hosted provider carries the API key in its path, query or
// userinfo, and this repo is public, so logs only ever show scheme + host.

/** `https://host[:port]` for a URL, without credentials, path or query. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return INVALID_URL;
  }
}

// Literal strings to scrub from every message, longest first, each with what
// replaces it. Filled from the configured RPC URL by registerSecretUrl().
// A literal matches with the two characters after each "%" compared without
// case (see replaceLiteral), and nothing else, so unrelated text ("100%dead")
// is never touched.
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
  // Every spelling a logger might give the same credential: "+" and " " are
  // interchangeable in a query string, and either may be percent-encoded with
  // upper- or lower-case hex.
  for (const p of [...credentialParts]) {
    for (const v of [p, p.replaceAll("+", " "), p.replaceAll(" ", "+")]) {
      const escaped = encodeURIComponent(v);
      const forms = [v, escaped, escaped.replaceAll("%20", "+"), encodeURI(v), new URLSearchParams({ k: v }).toString().slice(2)];
      for (const form of forms) credentialParts.add(form);
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
  ];
  // A piece inside the scheme or host would be replaced inside the redacted
  // "https://host" stripUrls() leaves behind, breaking it (and, if run first,
  // breaking URL detection so the rest of the URL leaked).
  const keep = (p: string) => !host.includes(p) && !SCHEME_WORDS.has(p.toLowerCase());
  for (const p of pathParts) if (p.length >= MIN_PATH_PIECE && keep(p)) next.push([p, "<redacted>"]);
  // The floor applies to the decoded value: "a%20b" is 3 characters, not 5.
  const decodedLength = (p: string) => {
    const plain = p.replaceAll("+", " ");
    try {
      return decodeURIComponent(plain).length;
    } catch {
      return plain.length;
    }
  };
  for (const p of credentialParts) {
    if (decodedLength(p) >= MIN_CREDENTIAL_PIECE && keep(p)) next.push([p, "<redacted>"]);
  }
  secrets = [...secrets, ...next].sort((a, b) => b[0].length - a[0].length);
}

/** For tests. */
export function resetSecretUrls(): void {
  secrets = [];
}

// Characters that commonly close a URL in prose or JSON. Kept after the
// redacted host so `"<url>",` still reads as `"<host>",`.
const TRAILING = /["'<>)\]},;.]+$/;
const CLOSERS: Record<string, string> = { ">": "<", ")": "(", "]": "[", "}": "{" };
const INVALID_URL = "<invalid url>";
const count = (text: string, ch: string) => text.split(ch).length - 1;

/** Replaces every occurrence of `literal`, treating the two characters after a "%" as case-insensitive hex. */
function replaceLiteral(text: string, literal: string, replacement: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    let j = 0;
    let k = i;
    while (j < literal.length && k < text.length) {
      if (literal[j] === "%" && text[k] === "%" && j + 2 < literal.length && k + 2 < text.length) {
        if (literal.slice(j + 1, j + 3).toLowerCase() !== text.slice(k + 1, k + 3).toLowerCase()) break;
        j += 3;
        k += 3;
      } else if (literal[j] === text[k]) {
        j++;
        k++;
      } else {
        break;
      }
    }
    if (j === literal.length && literal.length > 0) {
      out += replacement;
      i = k;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Replaces only the literal pieces of registered secret URLs; other URLs stay readable. */
export function scrubSecrets(message: string, onlyWithWhitespace = false): string {
  let out = message;
  for (const [literal, replacement] of secrets) {
    if (onlyWithWhitespace && !/\s/.test(literal)) continue;
    out = replaceLiteral(out, literal, replacement);
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
    const body = token.slice(0, token.length - tail.length);
    const host = redactUrl(body);
    // A closer whose opener sat inside the removed path ("/v2/<KEY>") has
    // nothing to close any more, and after "<invalid url>" a ">" is noise.
    let kept = "";
    const dropped: Record<string, number> = {};
    for (const ch of tail) {
      const opener = CLOSERS[ch];
      if (opener && (host === INVALID_URL ? ch === ">" : count(body, opener) > (dropped[ch] ?? 0) + count(body, ch))) {
        dropped[ch] = (dropped[ch] ?? 0) + 1;
        continue;
      }
      kept += ch;
    }
    return host + kept;
  });
  return scrubSecrets(urlsRedacted);
}
