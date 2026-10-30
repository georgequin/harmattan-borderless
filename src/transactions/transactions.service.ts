import { Injectable } from '@nestjs/common';
import { Prisma, Transaction, TransactionType } from '@prisma/client';
import { Currency } from '../common/currency';
import { Errors } from '../common/errors';
import { requestFingerprint } from '../common/idempotency';
import {
  applyRate,
  formatAmount,
  formatRate,
  fromDecimal,
  InvalidAmountError,
  MAX_AMOUNT_MINOR,
  parseAmount,
  rateFromDecimal,
  rateToDecimal,
  toDecimal,
} from '../common/money';
import { isUniqueViolation, PrismaService, PrismaTx } from '../prisma/prisma.service';
import { Quote, RatesService } from '../rates/rates.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  DepositDto,
  Direction,
  ListTransactionsQueryDto,
  SwapDto,
  TransactionPageDto,
  TransactionResponseDto,
  TransferDto,
} from './transactions.dto';

interface Movement {
  walletId: string;
  currency: Currency;
  /** Signed minor units: negative is a debit. */
  delta: bigint;
}

interface Plan {
  type: TransactionType;
  sourceWalletId: string | null;
  destinationWalletId: string;
  sourceCurrency: Currency;
  sourceAmount: bigint;
  destinationCurrency: Currency;
  destinationAmount: bigint;
  quote: Quote;
  movements: Movement[];
}

export interface ExecutionResult {
  transaction: TransactionResponseDto;
  /** True when this response is a replay of an earlier request with the same key. */
  replayed: boolean;
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
    private readonly wallets: WalletsService,
  ) {}

  deposit(walletId: string, dto: DepositDto, key: string): Promise<ExecutionResult> {
    const amount = this.validAmount(dto.amount);
    const fingerprint = requestFingerprint('deposit', {
      walletId,
      currency: dto.currency,
      amount: formatAmount(amount),
    });

    return this.execute(key, fingerprint, async () => {
      await this.wallets.assertExists(walletId);
      const quote = await this.rates.quote(dto.currency, dto.currency);
      return {
        type: TransactionType.DEPOSIT,
        sourceWalletId: null,
        destinationWalletId: walletId,
        sourceCurrency: dto.currency,
        sourceAmount: amount,
        destinationCurrency: dto.currency,
        destinationAmount: amount,
        quote,
        movements: [{ walletId, currency: dto.currency, delta: amount }],
      };
    });
  }

  swap(walletId: string, dto: SwapDto, key: string): Promise<ExecutionResult> {
    if (dto.fromCurrency === dto.toCurrency) throw Errors.sameCurrencySwap();
    const amount = this.validAmount(dto.amount);
    const fingerprint = requestFingerprint('swap', {
      walletId,
      fromCurrency: dto.fromCurrency,
      toCurrency: dto.toCurrency,
      amount: formatAmount(amount),
    });

    return this.execute(key, fingerprint, async () => {
      await this.wallets.assertExists(walletId);
      const quote = await this.rates.quote(dto.fromCurrency, dto.toCurrency);
      const converted = this.convert(amount, quote);
      return {
        type: TransactionType.SWAP,
        sourceWalletId: walletId,
        destinationWalletId: walletId,
        sourceCurrency: dto.fromCurrency,
        sourceAmount: amount,
        destinationCurrency: dto.toCurrency,
        destinationAmount: converted,
        quote,
        movements: [
          { walletId, currency: dto.fromCurrency, delta: -amount },
          { walletId, currency: dto.toCurrency, delta: converted },
        ],
      };
    });
  }

  transfer(walletId: string, dto: TransferDto, key: string): Promise<ExecutionResult> {
    if (dto.toWalletId === walletId) throw Errors.selfTransfer();
    const toCurrency = dto.toCurrency ?? dto.fromCurrency;
    const amount = this.validAmount(dto.amount);
    const fingerprint = requestFingerprint('transfer', {
      walletId,
      toWalletId: dto.toWalletId,
      fromCurrency: dto.fromCurrency,
      toCurrency,
      amount: formatAmount(amount),
    });

    return this.execute(key, fingerprint, async () => {
      await this.wallets.assertExists(walletId);
      await this.wallets.assertExists(dto.toWalletId);
      const quote = await this.rates.quote(dto.fromCurrency, toCurrency);
      const converted = this.convert(amount, quote);
      return {
        type: TransactionType.TRANSFER,
        sourceWalletId: walletId,
        destinationWalletId: dto.toWalletId,
        sourceCurrency: dto.fromCurrency,
        sourceAmount: amount,
        destinationCurrency: toCurrency,
        destinationAmount: converted,
        quote,
        movements: [
          { walletId, currency: dto.fromCurrency, delta: -amount },
          { walletId: dto.toWalletId, currency: toCurrency, delta: converted },
        ],
      };
    });
  }

  async list(walletId: string, query: ListTransactionsQueryDto): Promise<TransactionPageDto> {
    await this.wallets.assertExists(walletId);
    const where: Prisma.TransactionWhereInput = {
      AND: [
        { OR: [{ sourceWalletId: walletId }, { destinationWalletId: walletId }] },
        query.type ? { type: query.type } : {},
        query.currency
          ? { OR: [{ sourceCurrency: query.currency }, { destinationCurrency: query.currency }] }
          : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({ ...present(row), direction: directionFor(row, walletId) })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async get(id: string): Promise<TransactionResponseDto> {
    const row = await this.prisma.transaction.findUnique({ where: { id } });
    if (!row) throw Errors.transactionNotFound(id);
    return present(row);
  }

  /**
   * Runs a money movement exactly once per idempotency key.
   *
   * 1. A key that already has a committed transaction is replayed (or rejected
   *    if the request body differs).
   * 2. Otherwise the transaction row is inserted first, inside the DB
   *    transaction. Its UNIQUE(idempotency_key) index makes a concurrent request
   *    with the same key block until the first commits, then fail, so we replay.
   * 3. Balance rows are locked with SELECT ... FOR UPDATE in a fixed order
   *    (wallet id, currency), so parallel transfers serialise per balance and
   *    opposite-direction transfers cannot deadlock.
   * 4. Funds are checked under the lock; the CHECK (amount >= 0) constraint is
   *    a second line of defence.
   */
  private async execute(
    key: string,
    fingerprint: string,
    buildPlan: () => Promise<Plan>,
  ): Promise<ExecutionResult> {
    const existing = await this.prisma.transaction.findUnique({ where: { idempotencyKey: key } });
    if (existing) return this.replay(existing, fingerprint);

    const plan = await buildPlan();
    try {
      const created = await this.prisma.$transaction(
        async (tx) => {
          const row = await tx.transaction.create({
            data: {
              type: plan.type,
              sourceWalletId: plan.sourceWalletId,
              destinationWalletId: plan.destinationWalletId,
              sourceCurrency: plan.sourceCurrency,
              sourceAmount: toDecimal(plan.sourceAmount),
              destinationCurrency: plan.destinationCurrency,
              destinationAmount: toDecimal(plan.destinationAmount),
              rate: rateToDecimal(plan.quote.rate),
              rateSource: plan.quote.source,
              rateAsOf: plan.quote.asOf,
              idempotencyKey: key,
              requestHash: fingerprint,
            },
          });
          await this.applyMovements(tx, row.id, plan.movements);
          return row;
        },
        { maxWait: 10_000, timeout: 15_000 },
      );
      return { transaction: present(created), replayed: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.prisma.transaction.findUnique({
          where: { idempotencyKey: key },
        });
        if (winner) return this.replay(winner, fingerprint);
      }
      throw error;
    }
  }

  private async applyMovements(tx: PrismaTx, transactionId: string, movements: Movement[]) {
    const ordered = [...movements].sort((a, b) =>
      a.walletId === b.walletId
        ? a.currency.localeCompare(b.currency)
        : a.walletId.localeCompare(b.walletId),
    );

    const current = new Map<Movement, bigint>();
    for (const movement of ordered) {
      const [row] = await tx.$queryRaw<{ amount: Prisma.Decimal }[]>`
        SELECT amount FROM balances
        WHERE wallet_id = ${movement.walletId}::uuid
          AND currency = ${movement.currency}::"Currency"
        FOR UPDATE`;
      if (!row) throw Errors.walletNotFound(movement.walletId);
      current.set(movement, fromDecimal(row.amount));
    }

    for (const movement of movements) {
      const before = current.get(movement)!;
      const after = before + movement.delta;
      if (after < 0n) {
        throw Errors.insufficientFunds(
          movement.currency,
          formatAmount(before),
          formatAmount(-movement.delta),
        );
      }
      await tx.balance.update({
        where: { walletId_currency: { walletId: movement.walletId, currency: movement.currency } },
        data: { amount: toDecimal(after) },
      });
      await tx.ledgerEntry.create({
        data: {
          transactionId,
          walletId: movement.walletId,
          currency: movement.currency,
          amount: toDecimal(movement.delta),
          balanceAfter: toDecimal(after),
        },
      });
    }
  }

  private replay(existing: Transaction, fingerprint: string): ExecutionResult {
    if (existing.requestHash !== fingerprint) throw Errors.idempotencyKeyReused();
    return { transaction: present(existing), replayed: true };
  }

  private validAmount(input: string): bigint {
    let amount: bigint;
    try {
      amount = parseAmount(input);
    } catch (error) {
      if (error instanceof InvalidAmountError) throw Errors.invalidAmount(error.message);
      throw error;
    }
    if (amount <= 0n) throw Errors.invalidAmount('Amount must be greater than zero');
    if (amount > MAX_AMOUNT_MINOR) throw Errors.amountTooLarge(formatAmount(MAX_AMOUNT_MINOR));
    return amount;
  }

  private convert(amount: bigint, quote: Quote): bigint {
    const converted = applyRate(amount, quote.rate);
    if (converted <= 0n) throw Errors.amountTooSmall();
    return converted;
  }
}

export function present(row: Transaction): TransactionResponseDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    sourceWalletId: row.sourceWalletId,
    destinationWalletId: row.destinationWalletId,
    sourceCurrency: row.sourceCurrency,
    sourceAmount: formatAmount(fromDecimal(row.sourceAmount)),
    destinationCurrency: row.destinationCurrency,
    destinationAmount: formatAmount(fromDecimal(row.destinationAmount)),
    rate: formatRate(rateFromDecimal(row.rate)),
    rateSource: row.rateSource,
    rateAsOf: row.rateAsOf.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function directionFor(row: Transaction, walletId: string): Direction {
  if (row.type === TransactionType.SWAP) return Direction.SELF;
  return row.sourceWalletId === walletId ? Direction.OUT : Direction.IN;
}
