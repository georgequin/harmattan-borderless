import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RateSource, TransactionStatus, TransactionType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { Currency, SUPPORTED_CURRENCIES } from '../common/currency';
import { AMOUNT_PATTERN_SOURCE } from '../common/money';

const AMOUNT_RULE = new RegExp(AMOUNT_PATTERN_SOURCE);
const AMOUNT_MESSAGE =
  'amount must be a positive decimal string with at most 6 decimal places, e.g. "1500.25"';
const AMOUNT_DOC = {
  example: '1500.25',
  description:
    'Decimal string, up to 6 decimal places. Strings (not JSON numbers) avoid float rounding.',
};

export class DepositDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'cNGN' })
  @IsEnum(SUPPORTED_CURRENCIES)
  currency: Currency;

  @ApiProperty(AMOUNT_DOC)
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  amount: string;
}

export class SwapDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'cNGN' })
  @IsEnum(SUPPORTED_CURRENCIES)
  fromCurrency: Currency;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USDx' })
  @IsEnum(SUPPORTED_CURRENCIES)
  toCurrency: Currency;

  @ApiProperty({
    ...AMOUNT_DOC,
    description: `Amount of fromCurrency to sell. ${AMOUNT_DOC.description}`,
  })
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  amount: string;
}

export class TransferDto {
  @ApiProperty({ format: 'uuid', description: 'Receiving wallet' })
  @IsUUID()
  toWalletId: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USDx', description: 'Currency debited' })
  @IsEnum(SUPPORTED_CURRENCIES)
  fromCurrency: Currency;

  @ApiPropertyOptional({
    enum: SUPPORTED_CURRENCIES,
    example: 'cGHS',
    description: 'Currency credited to the receiver. Defaults to fromCurrency.',
  })
  @IsOptional()
  @IsEnum(SUPPORTED_CURRENCIES)
  toCurrency?: Currency;

  @ApiProperty({
    ...AMOUNT_DOC,
    description: `Amount of fromCurrency to send. ${AMOUNT_DOC.description}`,
  })
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  amount: string;
}

export class ListTransactionsQueryDto {
  @ApiPropertyOptional({ enum: TransactionType })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiPropertyOptional({
    enum: SUPPORTED_CURRENCIES,
    description: 'Matches transactions where either side is in this currency',
  })
  @IsOptional()
  @IsEnum(SUPPORTED_CURRENCIES)
  currency?: Currency;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export enum Direction {
  IN = 'IN',
  OUT = 'OUT',
  SELF = 'SELF',
}

export class TransactionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TransactionType })
  type: TransactionType;

  @ApiProperty({ enum: TransactionStatus })
  status: TransactionStatus;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Sender. Null for deposits, which come from outside the system.',
  })
  sourceWalletId: string | null;

  @ApiProperty({ format: 'uuid', description: 'Receiver' })
  destinationWalletId: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES })
  sourceCurrency: Currency;

  @ApiProperty({ example: '100.000000' })
  sourceAmount: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES })
  destinationCurrency: Currency;

  @ApiProperty({ example: '155000.000000', description: 'floor(sourceAmount x rate)' })
  destinationAmount: string;

  @ApiProperty({ example: '1550', description: 'Destination units per 1 source unit, as applied' })
  rate: string;

  @ApiProperty({ enum: RateSource, description: 'Where the applied rate came from' })
  rateSource: RateSource;

  @ApiProperty({ example: '2026-10-30T07:00:00.000Z', description: 'When the rate was refreshed' })
  rateAsOf: string;

  @ApiProperty({ example: '2026-10-30T07:00:01.000Z' })
  createdAt: string;

  @ApiPropertyOptional({
    enum: Direction,
    description: 'Only on wallet history: whether money came IN, went OUT, or moved within (SELF)',
  })
  direction?: Direction;
}

export class PageMetaDto {
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
}

export class TransactionPageDto {
  @ApiProperty({ type: [TransactionResponseDto] })
  data: TransactionResponseDto[];

  @ApiProperty({ type: PageMetaDto })
  meta: PageMetaDto;
}
