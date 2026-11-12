/**
 * Pins the EIP-712 digest and signature of the SignedPrice report the reporter
 * submits to AgriOracle, so a viem upgrade cannot change what a price report
 * hashes to without a test failing.
 *
 * The expected values were computed with viem 2.54.2 (the version before the
 * 2.57.16 bump) from the real domain and types in src/abi/domain.ts and a
 * public test key (anvil account #2), and are identical under 2.57.16.
 * Signatures are deterministic (RFC 6979), so the signature is pinned too.
 */
import { describe, expect, test } from "bun:test";
import { hashTypedData, recoverTypedDataAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AGRI_ORACLE_DOMAIN, SIGNED_PRICE_TYPES } from "../src/abi/domain.js";

const account = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

const typed = {
  domain: {
    ...AGRI_ORACLE_DOMAIN,
    chainId: 31337,
    verifyingContract: "0x5555555555555555555555555555555555555555",
  },
  types: SIGNED_PRICE_TYPES,
  primaryType: "SignedPrice",
  message: {
    questionId: "0xabababababababababababababababababababababababababababababababab",
    productCode: "P11003",
    priceMin: 150_000_000n,
    priceMax: 160_000_000n,
    sourceDate: 1_799_884_800n,
    expiryTime: 1_800_003_600n,
    nonce: 3n,
  },
} as const;

const DIGEST = "0x320d714caa0c1dfde8576418cee2fb1c025104c617210ef109c1920f62cea978";
const SIGNATURE =
  "0x2d9fcb40a685c31b88d45e1adff3968c972c29c7a3210849b48517658f61d7c248c54595e92fcffd2b54e90cd954c6d02eaeed8cd908f7dc1cb92e7accf2a5751c";

describe("SignedPrice EIP-712 golden values (viem 2.54.2 == 2.57.16)", () => {
  test("the digest is the pinned value", () => {
    expect(hashTypedData(typed)).toBe(DIGEST);
  });

  test("signing is deterministic and equals the pinned signature", async () => {
    expect(await account.signTypedData(typed)).toBe(SIGNATURE);
  });

  test("the pinned signature recovers the reporter and verifies", async () => {
    expect(await recoverTypedDataAddress({ ...typed, signature: SIGNATURE })).toBe(
      account.address,
    );
    expect(
      await verifyTypedData({ ...typed, address: account.address, signature: SIGNATURE }),
    ).toBe(true);
  });

  test("a one-unit change in the price no longer verifies", async () => {
    const tampered = {
      ...typed,
      message: { ...typed.message, priceMin: 150_000_001n },
    };
    expect(
      await verifyTypedData({ ...tampered, address: account.address, signature: SIGNATURE }),
    ).toBe(false);
  });
});
