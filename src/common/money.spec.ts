import {
  applyRate,
  crossRate,
  formatAmount,
  formatRate,
  fromDecimal,
  InvalidAmountError,
  parseAmount,
  rateFromNumber,
  RATE_SCALE,
  toDecimal,
} from './money';

describe('money', () => {
  describe('parseAmount', () => {
    it.each([
      ['1', 1_000_000n],
      ['0.000001', 1n],
      ['1500.25', 1_500_250_000n],
      ['0.1', 100_000n],
      ['999999999999.999999', 999_999_999_999_999_999n],
    ])('parses %s', (input, expected) => {
      expect(parseAmount(input)).toBe(expected);
    });

    it.each(['', '-1', '1.0000001', 'abc', '1e6', '01', '.5', '1.', ' 1', '1,000'])(
      'rejects %p',
      (input) => {
        expect(() => parseAmount(input)).toThrow(InvalidAmountError);
      },
    );

    it('does not lose precision the way floats do', () => {
      expect(parseAmount('0.1') + parseAmount('0.2')).toBe(parseAmount('0.3'));
    });
  });

  describe('formatAmount', () => {
    it('always renders 6 decimals', () => {
      expect(formatAmount(1_500_250_000n)).toBe('1500.250000');
      expect(formatAmount(1n)).toBe('0.000001');
      expect(formatAmount(0n)).toBe('0.000000');
      expect(formatAmount(-5_000_000n)).toBe('-5.000000');
    });

    it('round-trips with parseAmount', () => {
      expect(parseAmount(formatAmount(123_456_789n))).toBe(123_456_789n);
    });
  });

  describe('rates', () => {
    it('converts a JSON number into a scaled rate', () => {
      expect(rateFromNumber(1550.5)).toBe(1_550_500_000_000_000n);
      expect(() => rateFromNumber(0)).toThrow();
      expect(() => rateFromNumber(Number.NaN)).toThrow();
    });

    it('computes a cross rate via USD and rounds down', () => {
      const ngnPerUsd = rateFromNumber(1500);
      const ghsPerUsd = rateFromNumber(15);
      expect(formatRate(crossRate(ngnPerUsd, ghsPerUsd))).toBe('0.01');
      expect(formatRate(crossRate(ghsPerUsd, ngnPerUsd))).toBe('100');
      // 1/3 truncated at 12 dp, never rounded up
      expect(formatRate(crossRate(rateFromNumber(3), rateFromNumber(1)))).toBe('0.333333333333');
    });

    it('applies a rate rounding down so conversions never create money', () => {
      const third = crossRate(rateFromNumber(3), rateFromNumber(1));
      expect(applyRate(1_000_000n, third)).toBe(333_333n);
      expect(applyRate(1n, third)).toBe(0n);
      expect(applyRate(2_500_000n, 2n * RATE_SCALE)).toBe(5_000_000n);
    });

    it('a round trip through two conversions never yields more than it started with', () => {
      const a = rateFromNumber(1537.123456);
      const b = rateFromNumber(0.921234);
      for (const amount of [1n, 7n, 1_000_000n, 123_456_789_012n]) {
        const there = applyRate(amount, crossRate(a, b));
        const back = applyRate(there, crossRate(b, a));
        expect(back <= amount).toBe(true);
      }
    });
  });

  it('converts to and from Prisma decimals without loss', () => {
    const big = 123_456_789_012_345_678_901_234n;
    expect(fromDecimal(toDecimal(big))).toBe(big);
  });
});
