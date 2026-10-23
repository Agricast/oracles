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
});
