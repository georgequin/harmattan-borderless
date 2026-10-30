import { Currency } from '../common/currency';

/**
 * Last-resort static rate table, used only when the live provider is down and no
 * previously fetched snapshot exists. Units per 1 USD. XAF is derived from its
 * fixed peg to the euro (1 EUR = 655.957 XAF).
 */
export const FALLBACK_RATES_AS_OF = new Date('2026-10-01T00:00:00.000Z');

export const FALLBACK_RATES_PER_USD: Readonly<Record<Currency, string>> = {
  USDx: '1',
  EURx: '0.92',
  cNGN: '1550',
  cGHS: '15.5',
  cXAF: '603.48044',
};
