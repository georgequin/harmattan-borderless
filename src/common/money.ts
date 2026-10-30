import { Prisma } from '@prisma/client';

/**
 * Money is represented as a bigint count of minor units, 6 decimal places.
 * "12.5" cNGN is 12_500_000n. Floats are never used for amounts.
 */
export const AMOUNT_DECIMALS = 6;
export const MINOR_PER_UNIT = 10n ** BigInt(AMOUNT_DECIMALS);

/**
 * FX rates are represented as a bigint scaled by 10^12. A rate of
 * 0.000645161290 is 645_161_290n.
 */
export const RATE_DECIMALS = 12;
export const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);

/** Largest amount accepted in a single request: one billion units. */
export const MAX_AMOUNT_MINOR = 1_000_000_000n * MINOR_PER_UNIT;

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/;
export const AMOUNT_PATTERN_SOURCE = AMOUNT_PATTERN.source;

export class InvalidAmountError extends Error {}

/** Parses a decimal string such as "1500.25" into minor units. */
export function parseAmount(input: string): bigint {
  if (!AMOUNT_PATTERN.test(input)) {
    throw new InvalidAmountError(
      `Amount must be a positive decimal string with at most ${AMOUNT_DECIMALS} decimal places`,
    );
  }
  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * MINOR_PER_UNIT + BigInt(fraction.padEnd(AMOUNT_DECIMALS, '0'));
}

/** Formats minor units as a fixed 6-decimal string, e.g. 12_500_000n -> "12.500000". */
export function formatAmount(minor: bigint): string {
  return formatScaled(minor, AMOUNT_DECIMALS);
}

/** Formats a scaled rate, dropping trailing zeros, e.g. 1_550n * RATE_SCALE -> "1550". */
export function formatRate(scaled: bigint): string {
  const fixed = formatScaled(scaled, RATE_DECIMALS);
  return fixed.replace(/\.?0+$/, '');
}

function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * Converts a positive finite number (as returned by a JSON FX API) into a scaled
 * rate. Goes through toFixed so binary float noise beyond 12 dp is discarded.
 */
export function rateFromNumber(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid FX rate: ${value}`);
  }
  return decimalStringToScaled(value.toFixed(RATE_DECIMALS), RATE_DECIMALS);
}

export function decimalStringToScaled(value: string, decimals: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Value ${value} has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/**
 * Cross rate from one currency to another given both as "units per 1 USD".
 * Result is the number of `to` units per 1 `from` unit, scaled by RATE_SCALE and
 * rounded down.
 */
export function crossRate(fromPerUsd: bigint, toPerUsd: bigint): bigint {
  return (toPerUsd * RATE_SCALE) / fromPerUsd;
}

/**
 * Applies a scaled rate to an amount, rounding down. Rounding down means a
 * conversion can never create value: the platform keeps any sub-minor-unit dust.
 */
export function applyRate(amountMinor: bigint, rateScaled: bigint): bigint {
  return (amountMinor * rateScaled) / RATE_SCALE;
}

export function toDecimal(minor: bigint): Prisma.Decimal {
  return new Prisma.Decimal(minor.toString());
}

export function fromDecimal(value: Prisma.Decimal): bigint {
  return BigInt(value.toFixed(0));
}

export function rateToDecimal(scaled: bigint): Prisma.Decimal {
  return new Prisma.Decimal(formatScaled(scaled, RATE_DECIMALS));
}

export function rateFromDecimal(value: Prisma.Decimal): bigint {
  return decimalStringToScaled(value.toFixed(RATE_DECIMALS), RATE_DECIMALS);
}
