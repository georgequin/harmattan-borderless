import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { BalancesResponseDto, CreateWalletDto, WalletResponseDto } from './wallets.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a wallet identified by an email address or phone number' })
  @ApiCreatedResponse({ type: WalletResponseDto })
  @ApiConflictResponse({ description: 'WALLET_ALREADY_EXISTS' })
  create(@Body() dto: CreateWalletDto): Promise<WalletResponseDto> {
    return this.wallets.create(dto);
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get a wallet with all balances and the total in USD' })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiNotFoundResponse({ description: 'WALLET_NOT_FOUND' })
  get(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<WalletResponseDto> {
    return this.wallets.get(walletId);
  }

  @Get(':walletId/balances')
  @ApiOperation({ summary: 'Get real-time balances per stablecoin plus the total in USD' })
  @ApiOkResponse({ type: BalancesResponseDto })
  @ApiNotFoundResponse({ description: 'WALLET_NOT_FOUND' })
  balances(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<BalancesResponseDto> {
    return this.wallets.balances(walletId);
  }
}
