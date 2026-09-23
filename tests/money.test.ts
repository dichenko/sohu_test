import { describe, expect, it } from "vitest";
import { calculateSettlement, microsToTrx, trxToMicros } from "../src/money.js";

describe("money", () => {
  it("converts TRX without floating point loss", () => {
    expect(trxToMicros("100.300001")).toBe(100_300_001n);
    expect(microsToTrx(100_300_001n)).toBe("100.300001");
  });

  it("charges 131K allocation and refunds unused 65K tier", () => {
    const result = calculateSettlement({
      energyType: "131k",
      delegateCount: 131_000,
      usedEnergy: 65_000,
      price65Micros: 1_700_000n,
      price131Micros: 3_500_000n,
      feeMicros: 300_000n
    });
    expect(result.baseChargeMicros).toBe(3_500_000n);
    expect(result.refundMicros).toBe(1_700_000n);
    expect(result.netDebitMicros).toBe(2_100_000n);
  });

  it("does not refund a fully used 131K allocation", () => {
    const result = calculateSettlement({
      energyType: "131k",
      delegateCount: 131_000,
      usedEnergy: 130_000,
      price65Micros: 1_700_000n,
      price131Micros: 3_400_000n,
      feeMicros: 300_000n
    });
    expect(result.refundMicros).toBe(0n);
    expect(result.netDebitMicros).toBe(3_700_000n);
  });
});
