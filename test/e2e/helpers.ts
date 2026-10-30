import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Currency } from '../../src/common/currency';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProviderRates, RATE_PROVIDER, RateProvider } from '../../src/rates/rate-provider';

/**
 * Deterministic stand-in for open.er-api.com. Round numbers keep assertions
 * readable: 1 USDx = 1600 cNGN = 16 cGHS = 500 cXAF = 0.8 EURx.
 */
export class FakeRateProvider implements RateProvider {
  readonly name = 'fake-provider';
  failing = false;
  calls = 0;
  rates: Record<Currency, number> = { USDx: 1, EURx: 0.8, cNGN: 1600, cGHS: 16, cXAF: 500 };

  async fetchRatesPerUsd(): Promise<ProviderRates> {
    this.calls++;
    await Promise.resolve();
    if (this.failing) throw new Error('simulated provider outage');
    return { ratesPerUsd: { ...this.rates }, providerUpdatedAt: new Date() };
  }
}

export interface TestContext {
  app: INestApplication<App>;
  http: () => ReturnType<typeof request>;
  prisma: PrismaService;
  provider: FakeRateProvider;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  // No in-memory rate caching or failure backoff, so tests control the provider exactly.
  process.env.FX_CACHE_TTL_SECONDS = '0';
  process.env.FX_FAILURE_BACKOFF_SECONDS = '0';

  const provider = new FakeRateProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_PROVIDER)
    .useValue(provider)
    .compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  await app.init();

  return {
    app,
    http: () => request(app.getHttpServer()),
    prisma: app.get(PrismaService),
    provider,
    close: () => app.close(),
  };
}

export const uniqueEmail = (): string => `user-${randomUUID()}@example.com`;
export const key = (): string => randomUUID();

export async function createWallet(ctx: TestContext): Promise<string> {
  const res = await ctx.http().post('/wallets').send({ email: uniqueEmail() }).expect(201);
  return res.body.id as string;
}

export async function deposit(
  ctx: TestContext,
  walletId: string,
  currency: Currency,
  amount: string,
): Promise<void> {
  await ctx
    .http()
    .post(`/wallets/${walletId}/deposits`)
    .set('Idempotency-Key', key())
    .send({ currency, amount })
    .expect(201);
}

export async function balanceOf(
  ctx: TestContext,
  walletId: string,
  currency: Currency,
): Promise<string> {
  const res = await ctx.http().get(`/wallets/${walletId}/balances`).expect(200);
  const balances = res.body.balances as { currency: string; amount: string }[];
  return balances.find((b) => b.currency === currency)!.amount;
}

/**
 * The core accounting invariant: for every balance row, the stored amount equals
 * the sum of its ledger entries, and the last entry's balance_after matches.
 */
export async function expectLedgerConsistent(ctx: TestContext, walletIds: string[]): Promise<void> {
  const rows = await ctx.prisma.$queryRaw<{ wallet_id: string; currency: string; drift: string }[]>`
    SELECT b.wallet_id, b.currency::text, (b.amount - COALESCE(SUM(l.amount), 0))::text AS drift
    FROM balances b
    LEFT JOIN ledger_entries l ON l.wallet_id = b.wallet_id AND l.currency = b.currency
    WHERE b.wallet_id = ANY(${walletIds}::uuid[])
    GROUP BY b.wallet_id, b.currency, b.amount`;
  expect(rows.length).toBe(walletIds.length * 5);
  for (const row of rows) {
    expect({ ...row, drift: row.drift }).toEqual({ ...row, drift: '0' });
  }
}
