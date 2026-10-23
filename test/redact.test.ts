import { afterEach, describe, expect, test } from "bun:test";

import { redactUrl, registerSecretUrl, resetSecretUrls, stripUrls } from "../src/redact.js";

// Hosted RPC providers put the API key in the path or query, and this repo is
// public, so its logs must never carry a full RPC URL.
const KEYED = "https://eth-sepolia.g.alchemy.com/v2/SECRETKEY123?x=1";

afterEach(() => resetSecretUrls());

describe("redactUrl", () => {
  test("keeps only scheme and host", () => {
    expect(redactUrl(KEYED)).toBe("https://eth-sepolia.g.alchemy.com");
    expect(redactUrl("http://user:pw@10.0.0.5:8545/")).toBe("http://10.0.0.5:8545");
    expect(redactUrl("not a url")).toBe("<invalid url>");
  });
});

describe("stripUrls", () => {
  test("removes path, query and credentials from every URL in a message", () => {
    const viemMessage = `HTTP request failed.\n\nURL: ${KEYED}\nRequest body: {"method":"eth_call"}`;
    const out = stripUrls(viemMessage);
    expect(out).not.toContain("SECRETKEY123");
    expect(out).toContain("URL: https://eth-sepolia.g.alchemy.com");
    expect(stripUrls("a wss://u:p@node.example/key b")).toBe("a wss://node.example b");
    expect(stripUrls("no url here")).toBe("no url here");
  });

  test("a quote or bracket inside the URL token does not end the match early", () => {
    expect(stripUrls(`URL: https://rpc.example/v2/"SECRETKEY123" next`)).not.toContain("SECRETKEY123");
    expect(stripUrls(`URL: https://rpc.example/v2/<SECRETKEY123> next`)).not.toContain("SECRETKEY123");
    // A quoted URL keeps its closing quote so the surrounding text still reads.
    expect(stripUrls(`URL: "${KEYED}", retrying`)).toBe(`URL: "https://eth-sepolia.g.alchemy.com", retrying`);
  });

  test("the registered RPC URL and its path, query and userinfo are removed wherever they appear", () => {
    const rpc = "https://bob:PASSWORD9@rpc.example.com/v2/SECRETKEY123?apikey=QUERYKEY456";
    registerSecretUrl(rpc);
    const viemMessage = `HTTP request failed.\n\nURL: ${rpc}\nDetails: fetch failed`;
    const quoted = `request to "${rpc}" failed`;
    // Split across lines / stripped of its scheme, so no URL regex can see it.
    const split = `host rpc.example.com path /v2/SECRETKEY123 query apikey=QUERYKEY456 user bob:PASSWORD9`;
    for (const msg of [viemMessage, quoted, split]) {
      const out = stripUrls(msg);
      for (const secret of ["SECRETKEY123", "QUERYKEY456", "PASSWORD9"]) expect(out).not.toContain(secret);
    }
    expect(stripUrls(viemMessage)).toContain("URL: https://rpc.example.com");
  });

  test("key path segment, JSON-escaped and percent-encoded forms are scrubbed", () => {
    const KEY = "AbCdEf0123456789SECRETkey";
    registerSecretUrl(`https://eth-sepolia.g.alchemy.com/v2/${KEY}`);
    for (const msg of [
      `Must be authenticated! key ${KEY} is invalid`,
      `{"url":"https:\\/\\/eth-sepolia.g.alchemy.com\\/v2\\/${KEY}"}`,
      `eth-sepolia.g.alchemy.com/v2/${KEY}`,
      `https%3A%2F%2Feth-sepolia.g.alchemy.com%2Fv2%2F${KEY}`,
    ]) {
      expect(stripUrls(msg)).not.toContain(KEY);
    }
  });

  test("short generic path segments are not registered, so hostnames survive", () => {
    registerSecretUrl("https://rpc.example.com/rpc?apikey=QUERYKEY456");
    expect(stripUrls("connect to rpc.example.com failed")).toBe("connect to rpc.example.com failed");
    expect(stripUrls("fallback https://other.example/rpc/v1 down")).toBe("fallback https://other.example down");
    expect(stripUrls("apikey QUERYKEY456 rejected")).not.toContain("QUERYKEY456");
  });

  test("short passwords and query values are still scrubbed", () => {
    registerSecretUrl("https://bob:pw5ch@rpc.example.com/rpc?key=qv6chr&x=1");
    const out = stripUrls("auth bob:pw5ch failed for key qv6chr");
    expect(out).not.toContain("pw5ch");
    expect(out).not.toContain("qv6chr");
  });

  test("a credential piece that matches the scheme or host cannot break URL redaction", () => {
    // Short path key (under the 8-char path floor) so only the URL regex can
    // remove it; the password collides with the scheme or host.
    for (const pw of ["https", "http", "rpc1", "%2F%2Frp"]) {
      resetSecretUrls();
      registerSecretUrl(`https://bob:${pw}@rpc1.example.com/k3y7x`);
      for (const msg of [
        "URL: https://rpc1.example.com/k3y7x",
        `URL: "https://rpc1.example.com/k3y7x"`,
        "POST https://rpc1.example.com/k3y7x?x=1 failed",
      ]) {
        const out = stripUrls(msg);
        expect(out).not.toContain("k3y7x");
        expect(out).toContain("https://rpc1.example.com");
      }
    }
    // Not inside scheme or host, so it is registered; scrubbed before the URL
    // pattern ran, it would eat "s://" and leave the key in plain text.
    resetSecretUrls();
    registerSecretUrl(`https://bob:${encodeURIComponent("s://rpc1.example.com/zz")}@rpc1.example.com/k3y7x`);
    expect(stripUrls("URL: https://rpc1.example.com/zz/k3y7x")).toBe("URL: https://rpc1.example.com");
  });
});

describe("secrets containing whitespace once decoded", () => {
  test("%20 in the query value", () => {
    registerSecretUrl("https://rpc.example.com/rpc?apikey=abcd%20efgh1234");
    const out = stripUrls("URL: https://rpc.example.com/rpc?apikey=abcd efgh1234 failed");
    expect(out).not.toContain("efgh1234");
    expect(out).not.toContain("abcd");
  });

  test("+ in the query value", () => {
    registerSecretUrl("https://rpc.example.com/rpc?apikey=abcd+efgh1234");
    const out = stripUrls("URL: https://rpc.example.com/rpc?apikey=abcd efgh1234 failed");
    expect(out).not.toContain("efgh1234");
    expect(out).not.toContain("abcd");
  });

  test("%20 in the password", () => {
    registerSecretUrl("https://user:pass%20word99@rpc.example.com/");
    const out = stripUrls("fetch https://user:pass word99@rpc.example.com/ failed");
    expect(out).not.toContain("word99");
    expect(out).not.toContain("pass ");
  });
});

describe("raw query values", () => {
  test("the still-encoded value is redacted on its own", () => {
    registerSecretUrl("https://rpc.example.com/rpc?apikey=abcd%20efgh1234");
    expect(stripUrls("apikey abcd%20efgh1234 rejected")).not.toContain("efgh1234");
    resetSecretUrls();
    registerSecretUrl("https://rpc.example.com/rpc?apikey=abcd+efgh1234");
    expect(stripUrls("apikey abcd+efgh1234 rejected")).not.toContain("efgh1234");
  });
});

describe("cross-form query values", () => {
  // Fake value; every spelling a logger could produce for it.
  const spellings = ["ab+cd1234", "ab cd1234", "ab%2Bcd1234", "ab%2bcd1234", "ab%20cd1234", "ab%20cd1234".toLowerCase()];
  const urls = [
    "https://rpc.example.com/v2?key=ab+cd1234",
    "https://rpc.example.com/v2?key=ab%2Bcd1234",
    "https://rpc.example.com/v2?key=ab%2bcd1234",
    "https://rpc.example.com/v2?key=ab%20cd1234",
  ];

  for (const url of urls) {
    test(`every spelling is scrubbed after registering ${url}`, () => {
      registerSecretUrl(url);
      for (const s of spellings) {
        for (const text of [s, `x ${s} y`, `key=${s}`]) {
          expect(stripUrls(text)).not.toContain("cd1234");
        }
      }
    });
  }

  test("the 4-char minimum and host guard still hold", () => {
    registerSecretUrl("https://rpc.example.com/v2?key=a+b");
    expect(stripUrls("a b a+b https://rpc.example.com")).toBe("a b a+b https://rpc.example.com");
  });
});

describe("stray closing bracket", () => {
  test("a closer whose opener was inside the removed path is dropped", () => {
    expect(stripUrls("https://rpc.example.com/v2/<SECRETKEY123>")).toBe("https://rpc.example.com");
    expect(stripUrls("a <https://[bad>")).not.toContain(">>");
    expect(stripUrls("<invalid>")).toBe("<invalid>");
  });

  test("a balanced wrapper around the URL is kept", () => {
    expect(stripUrls("<https://a.example/p>")).toBe("<https://a.example>");
    expect(stripUrls("(see https://a.example/p)")).toBe("(see https://a.example)");
  });
});

describe("outer closers and escape case", () => {
  test("only closers matched by an opener inside the URL are dropped", () => {
    registerSecretUrl("https://rpc.example.com/v2/SECRETKEY123");
    expect(stripUrls("<https://rpc.example.com/v2/<abc>>")).toBe("<https://rpc.example.com>");
    expect(stripUrls("(https://other.io/(a))")).toBe("(https://other.io)");
    expect(stripUrls("[x](https://other.io/a_(b))")).toBe("[x](https://other.io)");
    expect(stripUrls('{"u":"https://other.io/a{b}"}')).toBe('{"u":"https://other.io"}');
  });

  test("escapes match whatever the hex case", () => {
    registerSecretUrl("https://rpc.example.com/v2?key=ab%2fcd%2Bef");
    for (const s of ["ab%2Fcd%2bef", "ab%2fcd%2Bef", "ab%2Fcd%2Bef", "ab%2fcd%2bef"]) {
      expect(stripUrls(`x ${s} y`)).not.toContain("cd");
    }
  });

  test("encodeURI and URLSearchParams spellings are scrubbed", () => {
    const value = "k3y(x)!'~*1";
    registerSecretUrl(`https://rpc.example.com/v2?key=${encodeURIComponent(value)}`);
    for (const s of [value, encodeURI(value), new URLSearchParams({ k: value }).toString().slice(2)]) {
      expect(stripUrls(`x ${s} y`)).not.toContain("k3y");
    }
  });
});

describe("per-secret escape matching and decoded length floor", () => {
  test("text that matches no secret is returned byte-identical", () => {
    registerSecretUrl("https://rpc.x.com/v2/SECRETKEY123?key=abcd");
    const text = "100%dead beef, grew 5%because, %2fpath";
    expect(stripUrls(text)).toBe(text);
  });

  test("the 4-char floor applies to the decoded value", () => {
    registerSecretUrl("https://rpc.x.com/v2?k=a+b");
    const text = "a b a+b a%20b a%2Bb";
    expect(stripUrls(text)).toBe(text);
  });
});
