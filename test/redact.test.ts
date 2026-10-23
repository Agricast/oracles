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
});
