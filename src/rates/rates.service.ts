import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateSource } from '@prisma/client';
import { Currency, SUPPORTED_CURRENCIES } from '../common/currency';
import {
  crossRate,
  decimalStringToScaled,
  RATE_DECIMALS,
  RATE_SCALE,
  rateFromDecimal,
  rateFromNumber,
  rateToDecimal,
} from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { FALLBACK_RATES_AS_OF, FALLBACK_RATES_PER_USD } from './fallback-rates';
import { RATE_PROVIDER, RateProvider } from './rate-provider';

/** A full set of rates, all from the same source. */
export interface RateTable {
  source: RateSource;
  /** Units per 1 USD, scaled by RATE_SCALE. */
  perUsd: Record<Currency, bigint>;
  /** When each currency's rate was last refreshed from the provider. */
  refreshedAt: Record<Currency, Date>;
}

export interface Quote {
  from: Currency;
  to: Currency;
  /** `to` units per 1 `from` unit, scaled by RATE_SCALE. */
  rate: bigint;
  source: RateSource;
  asOf: Date;
}

/**
 * Resolves FX rates with a three-level fallback:
 *   1. LIVE      - the provider, cached in memory for FX_CACHE_TTL_SECONDS
 *   2. CACHED    - the last good provider snapshot persisted in Postgres
 *   3. FALLBACK  - a static table compiled into the service
 * Every quote carries its source so transactions can record it.
 */
@Injectable()
export class RatesService {
  private readonly logger = new Logger(RatesService.name);
  private readonly ttlMs: number;
  private readonly backoffMs: number;

  private live?: { table: RateTable; fetchedAtMs: number };
  private inflight?: Promise<RateTable | undefined>;
  private providerBlockedUntilMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RATE_PROVIDER) private readonly provider: RateProvider,
    config: ConfigService,
  ) {
    this.ttlMs = Number(config.get('FX_CACHE_TTL_SECONDS', 300)) * 1000;
    this.backoffMs = Number(config.get('FX_FAILURE_BACKOFF_SECONDS', 30)) * 1000;
  }

  async getRateTable(): Promise<RateTable> {
    if (this.live && Date.now() - this.live.fetchedAtMs < this.ttlMs) {
      return this.live.table;
    }
    const fresh = await this.refreshFromProvider();
    return fresh ?? (await this.fallbackTable());
  }

  async quote(from: Currency, to: Currency): Promise<Quote> {
    if (from === to) {
      return { from, to, rate: RATE_SCALE, source: RateSource.IDENTITY, asOf: new Date() };
    }
    return quoteFromTable(await this.getRateTable(), from, to);
  }

  /** Single-flight: concurrent callers share one provider request. */
  private refreshFromProvider(): Promise<RateTable | undefined> {
    if (Date.now() < this.providerBlockedUntilMs) {
      return Promise.resolve(undefined);
    }
    this.inflight ??= this.fetchAndPersist().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchAndPersist(): Promise<RateTable | undefined> {
    let table: RateTable;
    try {
      const { ratesPerUsd } = await this.provider.fetchRatesPerUsd();
      const now = new Date();
      table = {
        source: RateSource.LIVE,
        perUsd: mapCurrencies((c) => rateFromNumber(ratesPerUsd[c])),
        refreshedAt: mapCurrencies(() => now),
      };
    } catch (error) {
      this.providerBlockedUntilMs = Date.now() + this.backoffMs;
      this.logger.warn(
        `FX provider ${this.provider.name} failed, using fallback: ${(error as Error).message}`,
      );
      return undefined;
    }

    this.live = { table, fetchedAtMs: Date.now() };
    try {
      await this.prisma.$transaction(
        SUPPORTED_CURRENCIES.map((currency) =>
          this.prisma.fxRateSnapshot.upsert({
            where: { currency },
            create: {
              currency,
              ratePerUsd: rateToDecimal(table.perUsd[currency]),
              fetchedAt: table.refreshedAt[currency],
            },
            update: {
              ratePerUsd: rateToDecimal(table.perUsd[currency]),
              fetchedAt: table.refreshedAt[currency],
            },
          }),
        ),
      );
    } catch (error) {
      // A failed snapshot write must not fail the request that triggered it.
      this.logger.error(`Could not persist FX snapshot: ${(error as Error).message}`);
    }
    return table;
  }

  private async fallbackTable(): Promise<RateTable> {
    const snapshots = await this.prisma.fxRateSnapshot.findMany();
    if (snapshots.length === SUPPORTED_CURRENCIES.length) {
      const byCurrency = new Map(snapshots.map((s) => [s.currency, s]));
      return {
        source: RateSource.CACHED,
        perUsd: mapCurrencies((c) => rateFromDecimal(byCurrency.get(c)!.ratePerUsd)),
        refreshedAt: mapCurrencies((c) => byCurrency.get(c)!.fetchedAt),
      };
    }
    return {
      source: RateSource.FALLBACK,
      perUsd: mapCurrencies((c) => decimalStringToScaled(FALLBACK_RATES_PER_USD[c], RATE_DECIMALS)),
      refreshedAt: mapCurrencies(() => FALLBACK_RATES_AS_OF),
    };
  }
}

export function quoteFromTable(table: RateTable, from: Currency, to: Currency): Quote {
  const asOf =
    table.refreshedAt[from] < table.refreshedAt[to]
      ? table.refreshedAt[from]
      : table.refreshedAt[to];
  return {
    from,
    to,
    rate: from === to ? RATE_SCALE : crossRate(table.perUsd[from], table.perUsd[to]),
    source: table.source,
    asOf,
  };
}

function mapCurrencies<T>(fn: (currency: Currency) => T): Record<Currency, T> {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((c) => [c, fn(c)])) as Record<Currency, T>;
}
