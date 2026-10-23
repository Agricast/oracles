// The RPC URL of a hosted provider carries the API key in its path or query,
// and this repo is public, so logs only ever show scheme + host.

/** `https://host[:port]` for a URL, without credentials, path or query. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<invalid url>";
  }
}

/** Replaces every URL in `message` (viem errors include "URL: ...") with its redacted form. */
export function stripUrls(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m));
}
