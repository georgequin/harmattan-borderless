import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RateSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, Matches, MaxLength } from 'class-validator';
import { Currency, SUPPORTED_CURRENCIES } from '../common/currency';

export class CreateWalletDto {
  @ApiPropertyOptional({ example: 'ada@example.com', description: 'Email or phone is required' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    example: '+2348012345678',
    description: 'E.164 format. Spaces, dashes and brackets are ignored.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s\-()]/g, '') : value,
  )
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be in E.164 format, e.g. +2348012345678' })
  phone?: string;
}

export class BalanceDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'cNGN' })
  currency: Currency;

  @ApiProperty({ example: '150000.000000' })
  amount: string;

  @ApiProperty({ example: '96.774193', description: 'USD equivalent, rounded down' })
  usdValue: string;
}

export class ValuationDto {
  @ApiProperty({ enum: RateSource })
  rateSource: RateSource;

  @ApiProperty({ example: '2026-10-30T07:00:00.000Z' })
  ratesAsOf: string;
}

export class BalancesResponseDto {
  @ApiProperty({ format: 'uuid' })
  walletId: string;

  @ApiProperty({ type: [BalanceDto] })
  balances: BalanceDto[];

  @ApiProperty({ example: '196.774193', description: 'Sum of all balances in USD, rounded down' })
  totalUsd: string;

  @ApiProperty({ type: ValuationDto })
  valuation: ValuationDto;
}

export class WalletResponseDto extends BalancesResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ nullable: true, type: String, example: 'ada@example.com' })
  email: string | null;

  @ApiProperty({ nullable: true, type: String, example: '+2348012345678' })
  phone: string | null;

  @ApiProperty({ example: '2026-10-30T07:00:00.000Z' })
  createdAt: string;
}
