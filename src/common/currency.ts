import { Currency } from '@prisma/client';

export { Currency };

export const SUPPORTED_CURRENCIES: readonly Currency[] = [
  Currency.cNGN,
  Currency.cGHS,
  Currency.cXAF,
  Currency.USDx,
  Currency.EURx,
];

/**
 * Each sandbox stablecoin is assumed to be pegged 1:1 to the fiat currency it
 * tracks, so its FX rate is the fiat rate for that ISO code.
 */
export const FIAT_PEG: Readonly<Record<Currency, string>> = {
  cNGN: 'NGN',
  cGHS: 'GHS',
  cXAF: 'XAF',
  USDx: 'USD',
  EURx: 'EUR',
};

export const USD_CURRENCY: Currency = Currency.USDx;
