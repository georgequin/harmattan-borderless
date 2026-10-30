import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FxRateSnapshot, Prisma, RateSource } from '@prisma/client';
import { Currency } from '../common/currency';
import { formatRate } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { FALLBACK_RATES_AS_OF } from './fallback-rates';
import { ProviderRates, RateProvider } from './rate-provider';
import { RatesService } from './rates.service';

const LIVE_RATES: Record<Currency, number> = {
  USDx: 1,
  EURx: 0.9,
  cNGN: 1500,
  cGHS: 15,
  cXAF: 600,
};

class FakeProvider implements RateProvider {
  readonly name = 'fake';
  calls = 0;
  failing = false;
  rates = { ...LIVE_RATES };

  async fetchRatesPerUsd(): Promise<ProviderRates> {
    this.calls++;
    await Promise.resolve();
    if (this.failing) throw new Error('provider down');
    return { ratesPerUsd: { ...this.rates }, providerUpdatedAt: new Date() };
  }
}

/** Minimal in-memory stand-in for the fxRateSnapshot table. */
function fakePrisma() {
  const rows = new Map<Currency, FxRateSnapshot>();
  const prisma = {
    rows,
    fxRateSnapshot: {
      findMany: jest.fn(() => Promise.resolve([...rows.values()])),
      upsert: jest.fn(
        (args: {
          where: { currency: Currency };
          create: { currency: Currency; ratePerUsd: Prisma.Decimal; fetchedAt: Date };
        }) => {
          rows.set(args.where.currency, { ...args.create });
          return Promise.resolve(args.create);
        },
      ),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return prisma;
}

function build(settings: Record<string, number> = {}) {
  const provider = new FakeProvider();
  const prisma = fakePrisma();
  const config = new ConfigService({
    FX_CACHE_TTL_SECONDS: 0,
    FX_FAILURE_BACKOFF_SECONDS: 0,
    ...settings,
  });
  const service = new RatesService(prisma as unknown as PrismaService, provider, config);
  return { service, provider, prisma };
}

describe('RatesService', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('serves live rates and persists them as a snapshot', async () => {
    const { service, prisma } = build();
    const quote = await service.quote(Currency.USDx, Currency.cNGN);
    expect(quote.source).toBe(RateSource.LIVE);
    expect(formatRate(quote.rate)).toBe('1500');
    expect(prisma.rows.size).toBe(5);
  });

  it('falls back to the last persisted snapshot when the provider fails', async () => {
    const { service, provider } = build();
    await service.getRateTable();
    provider.failing = true;
    provider.rates.cNGN = 9999; // must not leak through

    const quote = await service.quote(Currency.USDx, Currency.cNGN);
    expect(quote.source).toBe(RateSource.CACHED);
    expect(formatRate(quote.rate)).toBe('1500');
  });

  it('falls back to the static table when the provider fails and no snapshot exists', async () => {
    const { service, provider } = build();
    provider.failing = true;

    const quote = await service.quote(Currency.USDx, Currency.cNGN);
    expect(quote.source).toBe(RateSource.FALLBACK);
    expect(formatRate(quote.rate)).toBe('1550');
    expect(quote.asOf).toEqual(FALLBACK_RATES_AS_OF);
  });

  it('recovers to live rates once the provider is back', async () => {
    const { service, provider } = build();
    provider.failing = true;
    expect((await service.getRateTable()).source).toBe(RateSource.FALLBACK);
    provider.failing = false;
    expect((await service.getRateTable()).source).toBe(RateSource.LIVE);
  });

  it('caches live rates for the configured TTL', async () => {
    const { service, provider } = build({ FX_CACHE_TTL_SECONDS: 60 });
    await service.getRateTable();
    await service.getRateTable();
    expect(provider.calls).toBe(1);
  });

  it('collapses concurrent refreshes into one provider call', async () => {
    const { service, provider } = build();
    await Promise.all(Array.from({ length: 10 }, () => service.getRateTable()));
    expect(provider.calls).toBe(1);
  });

  it('backs off from a failing provider instead of calling it on every request', async () => {
    const { service, provider } = build({ FX_FAILURE_BACKOFF_SECONDS: 60 });
    provider.failing = true;
    await service.getRateTable();
    await service.getRateTable();
    expect(provider.calls).toBe(1);
  });

  it('quotes identity for same-currency pairs without touching the provider', async () => {
    const { service, provider } = build();
    const quote = await service.quote(Currency.cGHS, Currency.cGHS);
    expect(quote.source).toBe(RateSource.IDENTITY);
    expect(formatRate(quote.rate)).toBe('1');
    expect(provider.calls).toBe(0);
  });
});
