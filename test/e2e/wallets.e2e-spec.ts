import { createTestApp, deposit, TestContext, uniqueEmail } from './helpers';

describe('Wallets (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  it('creates a wallet by email with a zero balance in every stablecoin', async () => {
    const email = uniqueEmail();
    const res = await ctx.http().post('/wallets').send({ email }).expect(201);

    expect(res.body).toMatchObject({ email, phone: null, totalUsd: '0.000000' });
    expect(res.body.balances.map((b: { currency: string }) => b.currency)).toEqual([
      'cNGN',
      'cGHS',
      'cXAF',
      'USDx',
      'EURx',
    ]);
    expect(res.body.balances.every((b: { amount: string }) => b.amount === '0.000000')).toBe(true);
  });

  it('creates a wallet by phone number, normalising formatting', async () => {
    const digits = String(Date.now()).slice(-10);
    const res = await ctx
      .http()
      .post('/wallets')
      .send({ phone: `+234 ${digits.slice(0, 3)}-${digits.slice(3)}` })
      .expect(201);
    expect(res.body.phone).toBe(`+234${digits}`);
  });

  it('rejects a second wallet for the same email, case-insensitively', async () => {
    const email = uniqueEmail();
    await ctx.http().post('/wallets').send({ email }).expect(201);
    const res = await ctx
      .http()
      .post('/wallets')
      .send({ email: `  ${email.toUpperCase()} ` })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', details: { field: 'email' } });
  });

  it('rejects a second wallet for the same phone number', async () => {
    const phone = `+233${String(Date.now()).slice(-9)}`;
    await ctx.http().post('/wallets').send({ phone }).expect(201);
    const res = await ctx.http().post('/wallets').send({ phone, email: uniqueEmail() }).expect(409);
    expect(res.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', details: { field: 'phone' } });
  });

  it('only allows one wallet even when the same email is submitted concurrently', async () => {
    const email = uniqueEmail();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ctx.http().post('/wallets').send({ email })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it.each([
    [{}, 'IDENTITY_REQUIRED'],
    [{ email: 'not-an-email' }, 'VALIDATION_ERROR'],
    [{ phone: '08012345678' }, 'VALIDATION_ERROR'],
    [{ email: uniqueEmail(), admin: true }, 'VALIDATION_ERROR'],
  ])('rejects invalid input %p', async (body, code) => {
    const res = await ctx.http().post('/wallets').send(body).expect(400);
    expect(res.body.code).toBe(code);
  });

  it('returns balances with a USD total, rounded down', async () => {
    const res = await ctx.http().post('/wallets').send({ email: uniqueEmail() }).expect(201);
    const id = res.body.id as string;
    await deposit(ctx, id, 'cNGN', '1600');
    await deposit(ctx, id, 'EURx', '10');
    await deposit(ctx, id, 'cGHS', '0.000001'); // worth less than 0.000001 USD

    const balances = await ctx.http().get(`/wallets/${id}/balances`).expect(200);
    const byCurrency = Object.fromEntries(
      balances.body.balances.map((b: { currency: string }) => [b.currency, b]),
    );
    expect(byCurrency.cNGN).toEqual({ currency: 'cNGN', amount: '1600.000000', usdValue: '1.000000' });
    expect(byCurrency.EURx.usdValue).toBe('12.500000');
    expect(byCurrency.cGHS.usdValue).toBe('0.000000');
    expect(balances.body.totalUsd).toBe('13.500000');
    expect(balances.body.valuation.rateSource).toBe('LIVE');
  });

  it('returns 404 for an unknown wallet and 400 for a malformed id', async () => {
    const missing = await ctx
      .http()
      .get('/wallets/00000000-0000-4000-8000-000000000000')
      .expect(404);
    expect(missing.body.code).toBe('WALLET_NOT_FOUND');
    await ctx.http().get('/wallets/not-a-uuid').expect(400);
  });
});
