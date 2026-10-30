import { createTestApp, createWallet, deposit, key, TestContext } from './helpers';

describe('History, single transaction and rates (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  describe('GET /wallets/:id/transactions', () => {
    let alice: string;
    let bob: string;

    beforeAll(async () => {
      [alice, bob] = [await createWallet(ctx), await createWallet(ctx)];
      await deposit(ctx, alice, 'USDx', '100'); // 1
      await ctx
        .http()
        .post(`/wallets/${alice}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '10' })
        .expect(201); // 2
      await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: bob, fromCurrency: 'USDx', amount: '5' })
        .expect(201); // 3: sent
      await deposit(ctx, bob, 'cGHS', '50');
      await ctx
        .http()
        .post(`/wallets/${bob}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: alice, fromCurrency: 'cGHS', toCurrency: 'EURx', amount: '20' })
        .expect(201); // 4: received
    });

    it('lists deposits, swaps, sent and received transfers, newest first', async () => {
      const res = await ctx.http().get(`/wallets/${alice}/transactions`).expect(200);
      expect(
        res.body.data.map((t: { type: string; direction: string }) => [t.type, t.direction]),
      ).toEqual([
        ['TRANSFER', 'IN'],
        ['TRANSFER', 'OUT'],
        ['SWAP', 'SELF'],
        ['DEPOSIT', 'IN'],
      ]);
      expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 4, totalPages: 1 });
    });

    it('paginates', async () => {
      const page1 = await ctx.http().get(`/wallets/${alice}/transactions?pageSize=3`).expect(200);
      const page2 = await ctx
        .http()
        .get(`/wallets/${alice}/transactions?pageSize=3&page=2`)
        .expect(200);
      expect(page1.body.data).toHaveLength(3);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.meta).toMatchObject({ page: 2, total: 4, totalPages: 2 });
      expect(page2.body.data[0].type).toBe('DEPOSIT');
    });

    it('filters by type', async () => {
      const res = await ctx.http().get(`/wallets/${alice}/transactions?type=TRANSFER`).expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.every((t: { type: string }) => t.type === 'TRANSFER')).toBe(true);
    });

    it('filters by currency on either side of the transaction', async () => {
      const ngn = await ctx.http().get(`/wallets/${alice}/transactions?currency=cNGN`).expect(200);
      expect(ngn.body.data.map((t: { type: string }) => t.type)).toEqual(['SWAP']);

      const eur = await ctx.http().get(`/wallets/${alice}/transactions?currency=EURx`).expect(200);
      expect(eur.body.data).toHaveLength(1);
      expect(eur.body.data[0]).toMatchObject({
        sourceCurrency: 'cGHS',
        destinationCurrency: 'EURx',
      });
    });

    it('combines filters', async () => {
      const res = await ctx
        .http()
        .get(`/wallets/${alice}/transactions?type=DEPOSIT&currency=cNGN`)
        .expect(200);
      expect(res.body.data).toHaveLength(0);
    });

    it.each(['type=REFUND', 'currency=BTC', 'page=0', 'pageSize=101', 'page=abc'])(
      'rejects invalid query %s',
      async (query) => {
        await ctx.http().get(`/wallets/${alice}/transactions?${query}`).expect(400);
      },
    );

    it('fetches a single transaction by id', async () => {
      const list = await ctx.http().get(`/wallets/${alice}/transactions?type=SWAP`).expect(200);
      const swap = list.body.data[0];
      const res = await ctx.http().get(`/transactions/${swap.id}`).expect(200);
      const { direction, ...withoutDirection } = swap;
      expect(direction).toBe('SELF');
      expect(res.body).toEqual(withoutDirection);
    });

    it('returns 404 for an unknown transaction', async () => {
      const res = await ctx
        .http()
        .get('/transactions/00000000-0000-4000-8000-000000000000')
        .expect(404);
      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('GET /rates', () => {
    afterEach(() => {
      ctx.provider.failing = false;
    });

    it('returns every ordered pair with its last refresh time', async () => {
      const res = await ctx.http().get('/rates').expect(200);
      expect(res.body.source).toBe('LIVE');
      expect(res.body.rates).toHaveLength(20);
      const ngnToUsd = res.body.rates.find(
        (r: { from: string; to: string }) => r.from === 'cNGN' && r.to === 'USDx',
      );
      expect(ngnToUsd.rate).toBe('0.000625');
      expect(new Date(ngnToUsd.lastRefreshedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('quotes a single pair and converts an amount', async () => {
      const res = await ctx.http().get('/rates/quote?from=USDx&to=cXAF&amount=2.5').expect(200);
      expect(res.body).toMatchObject({
        from: 'USDx',
        to: 'cXAF',
        rate: '500',
        source: 'LIVE',
        amount: '2.500000',
        convertedAmount: '1250.000000',
      });
    });

    it('serves the last saved snapshot when the provider is down', async () => {
      await ctx.http().get('/rates').expect(200); // persist a LIVE snapshot
      ctx.provider.failing = true;

      const res = await ctx.http().get('/rates').expect(200);
      expect(res.body.source).toBe('CACHED');
      expect(
        res.body.rates.find(
          (r: { from: string; to: string }) => r.from === 'USDx' && r.to === 'cNGN',
        ).rate,
      ).toBe('1600');
    });

    it('serves the static table when the provider is down and nothing was saved', async () => {
      await ctx.prisma.fxRateSnapshot.deleteMany();
      ctx.provider.failing = true;

      const res = await ctx.http().get('/rates').expect(200);
      expect(res.body.source).toBe('FALLBACK');
      expect(
        res.body.rates.find(
          (r: { from: string; to: string }) => r.from === 'USDx' && r.to === 'cNGN',
        ).rate,
      ).toBe('1550');
    });

    it('keeps swaps and transfers working during an outage and records the rate source', async () => {
      const [alice, bob] = [await createWallet(ctx), await createWallet(ctx)];
      await deposit(ctx, alice, 'USDx', '10');
      await ctx.http().get('/rates').expect(200);
      ctx.provider.failing = true;

      const swap = await ctx
        .http()
        .post(`/wallets/${alice}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'USDx', toCurrency: 'cGHS', amount: '1' })
        .expect(201);
      expect(swap.body).toMatchObject({ rateSource: 'CACHED', destinationAmount: '16.000000' });

      const transfer = await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: bob, fromCurrency: 'USDx', toCurrency: 'EURx', amount: '1' })
        .expect(201);
      expect(transfer.body).toMatchObject({ rateSource: 'CACHED', destinationAmount: '0.800000' });
    });

    it('rejects unsupported currencies', async () => {
      await ctx.http().get('/rates/quote?from=USDx&to=BTC').expect(400);
    });
  });

  it('GET /health reports the database as up', async () => {
    await ctx.http().get('/health').expect(200, { status: 'ok', database: 'up' });
  });
});
