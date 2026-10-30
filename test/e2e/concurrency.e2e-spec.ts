import {
  balanceOf,
  createTestApp,
  createWallet,
  deposit,
  expectLedgerConsistent,
  key,
  TestContext,
} from './helpers';

describe('Concurrency (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  it('20 parallel transfers cannot overspend: exactly the affordable ones succeed', async () => {
    const [sender, receiver] = [await createWallet(ctx), await createWallet(ctx)];
    await deposit(ctx, sender, 'USDx', '100');

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx
          .http()
          .post(`/wallets/${sender}/transfers`)
          .set('Idempotency-Key', key())
          .send({ toWalletId: receiver, fromCurrency: 'USDx', amount: '10' }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 422)).toHaveLength(10);
    expect(await balanceOf(ctx, sender, 'USDx')).toBe('0.000000');
    expect(await balanceOf(ctx, receiver, 'USDx')).toBe('100.000000');
    await expectLedgerConsistent(ctx, [sender, receiver]);
  });

  it('parallel swaps draining the same balance never go negative', async () => {
    const wallet = await createWallet(ctx);
    await deposit(ctx, wallet, 'cNGN', '16000');

    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        ctx
          .http()
          .post(`/wallets/${wallet}/swaps`)
          .set('Idempotency-Key', key())
          .send({ fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '1600' }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(await balanceOf(ctx, wallet, 'cNGN')).toBe('0.000000');
    expect(await balanceOf(ctx, wallet, 'USDx')).toBe('10.000000');
    await expectLedgerConsistent(ctx, [wallet]);
  });

  it('the same idempotency key sent 10 times in parallel moves money exactly once', async () => {
    const [sender, receiver] = [await createWallet(ctx), await createWallet(ctx)];
    await deposit(ctx, sender, 'USDx', '100');
    const idempotencyKey = key();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx
          .http()
          .post(`/wallets/${sender}/transfers`)
          .set('Idempotency-Key', idempotencyKey)
          .send({ toWalletId: receiver, fromCurrency: 'USDx', amount: '30' }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await balanceOf(ctx, sender, 'USDx')).toBe('70.000000');
    expect(await balanceOf(ctx, receiver, 'USDx')).toBe('30.000000');

    const count = await ctx.prisma.transaction.count({ where: { idempotencyKey } });
    expect(count).toBe(1);
  });

  it('opposite-direction transfers between two wallets do not deadlock', async () => {
    const [a, b] = [await createWallet(ctx), await createWallet(ctx)];
    await deposit(ctx, a, 'USDx', '100');
    await deposit(ctx, b, 'USDx', '100');

    const send = (from: string, to: string) =>
      ctx
        .http()
        .post(`/wallets/${from}/transfers`)
        .set('Idempotency-Key', key())
        .send({ toWalletId: to, fromCurrency: 'USDx', amount: '1' });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? send(a, b) : send(b, a))),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await balanceOf(ctx, a, 'USDx')).toBe('100.000000');
    expect(await balanceOf(ctx, b, 'USDx')).toBe('100.000000');
    await expectLedgerConsistent(ctx, [a, b]);
  });

  it('the database itself refuses a negative balance', async () => {
    const wallet = await createWallet(ctx);
    await expect(
      ctx.prisma.$executeRaw`
        UPDATE balances SET amount = -1 WHERE wallet_id = ${wallet}::uuid AND currency = 'USDx'`,
    ).rejects.toThrow(/balances_amount_non_negative/);
  });

  it('the ledger is append-only', async () => {
    const wallet = await createWallet(ctx);
    await deposit(ctx, wallet, 'USDx', '1');
    await expect(
      ctx.prisma.$executeRaw`DELETE FROM ledger_entries WHERE wallet_id = ${wallet}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});
