import {
  balanceOf,
  createTestApp,
  createWallet,
  deposit,
  expectLedgerConsistent,
  key,
  TestContext,
} from './helpers';

describe('Deposits, swaps and transfers (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  describe('POST /wallets/:id/deposits', () => {
    it('credits the balance immediately and records a transaction', async () => {
      const wallet = await createWallet(ctx);
      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/deposits`)
        .set('Idempotency-Key', key())
        .send({ currency: 'cNGN', amount: '150000.5' })
        .expect(201);

      expect(res.headers['idempotent-replayed']).toBe('false');
      expect(res.body).toMatchObject({
        type: 'DEPOSIT',
        status: 'COMPLETED',
        sourceWalletId: null,
        destinationWalletId: wallet,
        sourceCurrency: 'cNGN',
        sourceAmount: '150000.500000',
        destinationCurrency: 'cNGN',
        destinationAmount: '150000.500000',
        rate: '1',
        rateSource: 'IDENTITY',
      });
      expect(await balanceOf(ctx, wallet, 'cNGN')).toBe('150000.500000');
      await expectLedgerConsistent(ctx, [wallet]);
    });

    it('requires an Idempotency-Key header', async () => {
      const wallet = await createWallet(ctx);
      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/deposits`)
        .send({ currency: 'USDx', amount: '1' })
        .expect(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it.each([
      [{ currency: 'USDx', amount: '0' }, 'INVALID_AMOUNT'],
      [{ currency: 'USDx', amount: '0.000000' }, 'INVALID_AMOUNT'],
      [{ currency: 'USDx', amount: '-5' }, 'VALIDATION_ERROR'],
      [{ currency: 'USDx', amount: '1.0000001' }, 'VALIDATION_ERROR'],
      [{ currency: 'USDx', amount: 10 }, 'VALIDATION_ERROR'],
      [{ currency: 'USDx', amount: '1e3' }, 'VALIDATION_ERROR'],
      [{ currency: 'USDx', amount: '1000000000.000001' }, 'AMOUNT_TOO_LARGE'],
      [{ currency: 'BTC', amount: '1' }, 'VALIDATION_ERROR'],
      [{ amount: '1' }, 'VALIDATION_ERROR'],
    ])('rejects %p', async (body, code) => {
      const wallet = await createWallet(ctx);
      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/deposits`)
        .set('Idempotency-Key', key())
        .send(body)
        .expect(400);
      expect(res.body.code).toBe(code);
      expect(await balanceOf(ctx, wallet, 'USDx')).toBe('0.000000');
    });

    it('returns 404 for an unknown wallet', async () => {
      const res = await ctx
        .http()
        .post('/wallets/00000000-0000-4000-8000-000000000000/deposits')
        .set('Idempotency-Key', key())
        .send({ currency: 'USDx', amount: '1' })
        .expect(404);
      expect(res.body.code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('POST /wallets/:id/swaps', () => {
    it('converts at the current rate', async () => {
      const wallet = await createWallet(ctx);
      await deposit(ctx, wallet, 'USDx', '100');

      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '25.5' })
        .expect(201);

      expect(res.body).toMatchObject({
        type: 'SWAP',
        sourceWalletId: wallet,
        destinationWalletId: wallet,
        sourceAmount: '25.500000',
        destinationAmount: '40800.000000',
        rate: '1600',
        rateSource: 'LIVE',
      });
      expect(await balanceOf(ctx, wallet, 'USDx')).toBe('74.500000');
      expect(await balanceOf(ctx, wallet, 'cNGN')).toBe('40800.000000');
      await expectLedgerConsistent(ctx, [wallet]);
    });

    it('rounds the converted amount down, never up', async () => {
      const wallet = await createWallet(ctx);
      await deposit(ctx, wallet, 'cNGN', '1');
      ctx.provider.rates.cGHS = 15.97; // cNGN->cGHS = 0.00998125

      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'cNGN', toCurrency: 'cGHS', amount: '0.000333' })
        .expect(201);
      ctx.provider.rates.cGHS = 16;

      // 0.000333 x 0.00998125 = 0.0000033237... -> 0.000003
      expect(res.body.destinationAmount).toBe('0.000003');
    });

    it('rejects a swap that would make the balance negative, leaving balances untouched', async () => {
      const wallet = await createWallet(ctx);
      await deposit(ctx, wallet, 'cGHS', '10');

      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'cGHS', toCurrency: 'USDx', amount: '10.000001' })
        .expect(422);

      expect(res.body).toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        details: { currency: 'cGHS', available: '10.000000', requested: '10.000001' },
      });
      expect(await balanceOf(ctx, wallet, 'cGHS')).toBe('10.000000');
      expect(await balanceOf(ctx, wallet, 'USDx')).toBe('0.000000');
    });

    it('rejects a swap whose output would round to zero', async () => {
      const wallet = await createWallet(ctx);
      await deposit(ctx, wallet, 'cNGN', '1');
      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '0.000001' })
        .expect(422);
      expect(res.body.code).toBe('AMOUNT_TOO_SMALL');
    });

    it('rejects swapping a currency into itself', async () => {
      const wallet = await createWallet(ctx);
      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/swaps`)
        .set('Idempotency-Key', key())
        .send({ fromCurrency: 'USDx', toCurrency: 'USDx', amount: '1' })
        .expect(400);
      expect(res.body.code).toBe('SAME_CURRENCY_SWAP');
    });
  });

  describe('POST /wallets/:id/transfers', () => {
    it('sends the same currency to another wallet', async () => {
      const [alice, bob] = [await createWallet(ctx), await createWallet(ctx)];
      await deposit(ctx, alice, 'USDx', '50');

      const res = await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: bob, fromCurrency: 'USDx', amount: '20' })
        .expect(201);

      expect(res.body).toMatchObject({
        type: 'TRANSFER',
        sourceWalletId: alice,
        destinationWalletId: bob,
        sourceCurrency: 'USDx',
        destinationCurrency: 'USDx',
        sourceAmount: '20.000000',
        destinationAmount: '20.000000',
        rate: '1',
        rateSource: 'IDENTITY',
      });
      expect(await balanceOf(ctx, alice, 'USDx')).toBe('30.000000');
      expect(await balanceOf(ctx, bob, 'USDx')).toBe('20.000000');
      await expectLedgerConsistent(ctx, [alice, bob]);
    });

    it('converts automatically across currencies and records every required field', async () => {
      const [alice, bob] = [await createWallet(ctx), await createWallet(ctx)];
      await deposit(ctx, alice, 'cGHS', '100');

      const res = await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: bob, fromCurrency: 'cGHS', toCurrency: 'cNGN', amount: '12.34' })
        .expect(201);

      // sender, receiver, source amount + currency, destination amount + currency, rate, timestamp
      expect(res.body).toMatchObject({
        sourceWalletId: alice,
        destinationWalletId: bob,
        sourceCurrency: 'cGHS',
        sourceAmount: '12.340000',
        destinationCurrency: 'cNGN',
        destinationAmount: '1234.000000',
        rate: '100',
        rateSource: 'LIVE',
      });
      expect(new Date(res.body.createdAt).getTime()).not.toBeNaN();
      expect(new Date(res.body.rateAsOf).getTime()).not.toBeNaN();
      expect(await balanceOf(ctx, alice, 'cGHS')).toBe('87.660000');
      expect(await balanceOf(ctx, bob, 'cNGN')).toBe('1234.000000');
      await expectLedgerConsistent(ctx, [alice, bob]);
    });

    it('rejects an overdraft without moving any money', async () => {
      const [alice, bob] = [await createWallet(ctx), await createWallet(ctx)];
      await deposit(ctx, alice, 'EURx', '5');
      const res = await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: bob, fromCurrency: 'EURx', amount: '5.01' })
        .expect(422);
      expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(ctx, alice, 'EURx')).toBe('5.000000');
      expect(await balanceOf(ctx, bob, 'EURx')).toBe('0.000000');
    });

    it('rejects transfers to self and to unknown wallets', async () => {
      const alice = await createWallet(ctx);
      await deposit(ctx, alice, 'USDx', '5');

      const self = await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: alice, fromCurrency: 'USDx', amount: '1' })
        .expect(400);
      expect(self.body.code).toBe('SELF_TRANSFER');

      const unknown = await ctx
        .http()
        .post(`/wallets/${alice}/transfers`)
        .set('Idempotency-Key', key())
        .send({
          toWalletId: '00000000-0000-4000-8000-000000000000',
          fromCurrency: 'USDx',
          amount: '1',
        })
        .expect(404);
      expect(unknown.body.code).toBe('WALLET_NOT_FOUND');
      expect(await balanceOf(ctx, alice, 'USDx')).toBe('5.000000');
    });
  });

  describe('idempotency', () => {
    it('replays a retried request instead of processing it twice', async () => {
      const wallet = await createWallet(ctx);
      const idempotencyKey = key();
      const send = () =>
        ctx
          .http()
          .post(`/wallets/${wallet}/deposits`)
          .set('Idempotency-Key', idempotencyKey)
          .send({ currency: 'USDx', amount: '10' });

      const first = await send().expect(201);
      const retry = await send().expect(200);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await balanceOf(ctx, wallet, 'USDx')).toBe('10.000000');
    });

    it('treats an equivalent amount format as the same request', async () => {
      const wallet = await createWallet(ctx);
      const idempotencyKey = key();
      await ctx
        .http()
        .post(`/wallets/${wallet}/deposits`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ currency: 'USDx', amount: '10' })
        .expect(201);
      await ctx
        .http()
        .post(`/wallets/${wallet}/deposits`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ currency: 'USDx', amount: '10.00' })
        .expect(200);
      expect(await balanceOf(ctx, wallet, 'USDx')).toBe('10.000000');
    });

    it('rejects a key reused for a different request', async () => {
      const wallet = await createWallet(ctx);
      const idempotencyKey = key();
      await ctx
        .http()
        .post(`/wallets/${wallet}/deposits`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ currency: 'USDx', amount: '10' })
        .expect(201);

      const res = await ctx
        .http()
        .post(`/wallets/${wallet}/swaps`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '10' })
        .expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(ctx, wallet, 'cNGN')).toBe('0.000000');
    });

    it('lets a failed request be retried with the same key once funds arrive', async () => {
      const [alice, bob] = [await createWallet(ctx), await createWallet(ctx)];
      const idempotencyKey = key();
      const send = () =>
        ctx
          .http()
          .post(`/wallets/${alice}/transfers`)
          .set('Idempotency-Key', idempotencyKey)
          .send({ toWalletId: bob, fromCurrency: 'USDx', amount: '5' });

      await send().expect(422);
      await deposit(ctx, alice, 'USDx', '5');
      await send().expect(201);
      await send().expect(200);
      expect(await balanceOf(ctx, bob, 'USDx')).toBe('5.000000');
    });
  });
});
