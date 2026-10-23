import { describe, expect, test } from "bun:test";

import { redactUrl, stripUrls } from "../src/redact.js";

// Hosted RPC providers put the API key in the path or query, and this repo is
// public, so its logs must never carry a full RPC URL.
const KEYED = "https://eth-sepolia.g.alchemy.com/v2/SECRETKEY123?x=1";

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
});
