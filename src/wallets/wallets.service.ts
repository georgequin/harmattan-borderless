import { HttpStatus, Injectable } from '@nestjs/common';
import { Currency, SUPPORTED_CURRENCIES, USD_CURRENCY } from '../common/currency';
import { ApiError, Errors } from '../common/errors';
import { applyRate, formatAmount, fromDecimal } from '../common/money';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';
import { quoteFromTable, RatesService } from '../rates/rates.service';
import { BalancesResponseDto, CreateWalletDto, WalletResponseDto } from './wallets.dto';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
  ) {}

  async create(dto: CreateWalletDto): Promise<WalletResponseDto> {
    if (!dto.email && !dto.phone) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'IDENTITY_REQUIRED',
        'Provide an email address or a phone number',
      );
    }

    try {
      // Every wallet gets a zero balance row per currency up front, so money
      // movements only ever UPDATE existing rows and never race on an INSERT.
      const wallet = await this.prisma.wallet.create({
        data: {
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          balances: { create: SUPPORTED_CURRENCIES.map((currency) => ({ currency })) },
        },
      });
      return this.get(wallet.id);
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw Errors.walletExists('email');
      if (isUniqueViolation(error, 'phone')) throw Errors.walletExists('phone');
      throw error;
    }
  }

  async get(walletId: string): Promise<WalletResponseDto> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw Errors.walletNotFound(walletId);
    const balances = await this.balances(walletId);
    return {
      id: wallet.id,
      email: wallet.email,
      phone: wallet.phone,
      createdAt: wallet.createdAt.toISOString(),
      ...balances,
    };
  }

  async balances(walletId: string): Promise<BalancesResponseDto> {
    const rows = await this.prisma.balance.findMany({ where: { walletId } });
    if (rows.length === 0) throw Errors.walletNotFound(walletId);

    const table = await this.rates.getRateTable();
    const byCurrency = new Map(rows.map((r) => [r.currency, fromDecimal(r.amount)]));
    let totalUsd = 0n;
    let oldest: Date | undefined;

    const balances = SUPPORTED_CURRENCIES.map((currency: Currency) => {
      const amount = byCurrency.get(currency) ?? 0n;
      const quote = quoteFromTable(table, currency, USD_CURRENCY);
      const usd = applyRate(amount, quote.rate);
      totalUsd += usd;
      if (!oldest || quote.asOf < oldest) oldest = quote.asOf;
      return { currency, amount: formatAmount(amount), usdValue: formatAmount(usd) };
    });

    return {
      walletId,
      balances,
      totalUsd: formatAmount(totalUsd),
      valuation: { rateSource: table.source, ratesAsOf: (oldest ?? new Date()).toISOString() },
    };
  }

  async assertExists(walletId: string): Promise<void> {
    const count = await this.prisma.wallet.count({ where: { id: walletId } });
    if (count === 0) throw Errors.walletNotFound(walletId);
  }
}
