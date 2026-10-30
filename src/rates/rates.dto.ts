import { ApiProperty } from '@nestjs/swagger';
import { RateSource } from '@prisma/client';
import { IsEnum, IsOptional, Matches } from 'class-validator';
import { Currency, SUPPORTED_CURRENCIES } from '../common/currency';
import { AMOUNT_PATTERN_SOURCE } from '../common/money';

export class PairRateDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'cNGN' })
  from: Currency;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USDx' })
  to: Currency;

  @ApiProperty({ example: '0.000645161290', description: '`to` units per 1 `from` unit' })
  rate: string;

  @ApiProperty({ example: '2026-10-30T07:00:00.000Z' })
  lastRefreshedAt: string;
}

export class RatesResponseDto {
  @ApiProperty({ enum: RateSource, example: RateSource.LIVE })
  source: RateSource;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, isArray: true })
  currencies: Currency[];

  @ApiProperty({ type: [PairRateDto], description: 'Every ordered pair of supported currencies' })
  rates: PairRateDto[];
}

export class QuoteQueryDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USDx' })
  @IsEnum(SUPPORTED_CURRENCIES)
  from: Currency;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'cNGN' })
  @IsEnum(SUPPORTED_CURRENCIES)
  to: Currency;

  @ApiProperty({ required: false, example: '100.00' })
  @IsOptional()
  @Matches(new RegExp(AMOUNT_PATTERN_SOURCE), {
    message: 'amount must be a positive decimal string with at most 6 decimal places',
  })
  amount?: string;
}

export class QuoteResponseDto extends PairRateDto {
  @ApiProperty({ enum: RateSource })
  source: RateSource;

  @ApiProperty({ required: false, example: '100.000000' })
  amount?: string;

  @ApiProperty({ required: false, example: '155000.000000', description: 'Rounded down' })
  convertedAmount?: string;
}
