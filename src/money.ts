export const MICROS_PER_TRX = 1_000_000n;

export function trxToMicros(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid non-negative TRX amount: ${text}`);
  const [whole = "0", fraction = ""] = text.split(".");
  const rounded = `${fraction}0000000`.slice(0, 7);
  let micros = BigInt(whole) * MICROS_PER_TRX + BigInt(rounded.slice(0, 6));
  if (Number(rounded[6]) >= 5) micros += 1n;
  return micros;
}

export function microsToTrx(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / MICROS_PER_TRX;
  const fraction = (absolute % MICROS_PER_TRX).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export type Settlement = {
  allocatedEnergy: number;
  usedEnergy: number;
  baseChargeMicros: bigint;
  feeMicros: bigint;
  refundMicros: bigint;
  netDebitMicros: bigint;
};

export function calculateSettlement(input: {
  energyType?: string | null;
  delegateCount?: number | null;
  usedEnergy?: number | null;
  price65Micros: bigint;
  price131Micros: bigint;
  feeMicros: bigint;
}): Settlement {
  const allocatedEnergy = input.delegateCount && input.delegateCount > 0
    ? input.delegateCount
    : input.energyType?.toLowerCase() === "131k" ? 131_000 : 65_000;
  const usedEnergy = Math.max(0, input.usedEnergy ?? allocatedEnergy);
  const isLargeAllocation = allocatedEnergy > 65_000 || input.energyType?.toLowerCase() === "131k";
  const baseChargeMicros = isLargeAllocation ? input.price131Micros : input.price65Micros;
  // Souhu reserves a 131K tier, but a 65K actual spend means the unused tier is returned.
  const refundMicros = isLargeAllocation && usedEnergy <= 65_000
    ? input.price65Micros
    : 0n;
  return {
    allocatedEnergy,
    usedEnergy,
    baseChargeMicros,
    feeMicros: input.feeMicros,
    refundMicros,
    netDebitMicros: baseChargeMicros + input.feeMicros - refundMicros
  };
}
