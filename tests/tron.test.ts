import { describe, expect, it } from "vitest";
import { isValidTronAddress } from "../src/tron.js";

describe("TRON Base58Check", () => {
  it("accepts a valid address", () => {
    expect(isValidTronAddress("TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE")).toBe(true);
  });

  it("rejects a checksum typo", () => {
    expect(isValidTronAddress("TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSF")).toBe(false);
  });
});
