import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Currency, FIAT_PEG, SUPPORTED_CURRENCIES } from '../common/currency';

export const RATE_PROVIDER = Symbol('RATE_PROVIDER');

export interface ProviderRates {
  /** Units of each currency per 1 USD. */
  ratesPerUsd: Record<Currency, number>;
  /** When the provider says it last updated these rates. */
  providerUpdatedAt: Date;
}

export interface RateProvider {
  readonly name: string;
  fetchRatesPerUsd(): Promise<ProviderRates>;
}

interface ErApiResponse {
  result?: string;
  base_code?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
}

/** Live rates from https://open.er-api.com (free, no API key, USD base). */
@Injectable()
export class OpenErApiRateProvider implements RateProvider {
  readonly name = 'open.er-api.com';
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.url = config.get<string>('FX_PROVIDER_URL', 'https://open.er-api.com/v6/latest/USD');
    this.timeoutMs = Number(config.get('FX_PROVIDER_TIMEOUT_MS', 3000));
  }

  async fetchRatesPerUsd(): Promise<ProviderRates> {
    const response = await fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) {
      throw new Error(`FX provider responded ${response.status}`);
    }
    const body = (await response.json()) as ErApiResponse;
    if (body.result !== 'success' || body.base_code !== 'USD' || !body.rates) {
      throw new Error('FX provider returned an unexpected payload');
    }

    const ratesPerUsd = {} as Record<Currency, number>;
    for (const currency of SUPPORTED_CURRENCIES) {
      const rate = body.rates[FIAT_PEG[currency]];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`FX provider has no valid rate for ${FIAT_PEG[currency]}`);
      }
      ratesPerUsd[currency] = rate;
    }

    return {
      ratesPerUsd,
      providerUpdatedAt: body.time_last_update_unix
        ? new Date(body.time_last_update_unix * 1000)
        : new Date(),
    };
  }
}
