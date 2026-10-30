import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { IDEMPOTENCY_HEADER, IdempotencyKey, REPLAYED_HEADER } from '../common/idempotency';
import {
  DepositDto,
  ListTransactionsQueryDto,
  SwapDto,
  TransactionPageDto,
  TransactionResponseDto,
  TransferDto,
} from './transactions.dto';
import { ExecutionResult, TransactionsService } from './transactions.service';

const IdempotencyHeaderDoc = ApiHeader({
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    'Unique key per logical operation (8-128 chars, e.g. a UUID). Retrying with the same key ' +
    `returns the original result with status 200 and header ${REPLAYED_HEADER}: true.`,
});

/** 201 for a new transaction, 200 plus a replay header when the key was seen before. */
function respond(res: Response, result: ExecutionResult): TransactionResponseDto {
  res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
  res.setHeader(REPLAYED_HEADER, String(result.replayed));
  return result.transaction;
}

@ApiTags('transactions')
@Controller('wallets/:walletId')
export class WalletTransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post('deposits')
  @ApiOperation({ summary: 'Deposit (simulated) funds into a wallet' })
  @IdempotencyHeaderDoc
  @ApiCreatedResponse({ type: TransactionResponseDto })
  @ApiOkResponse({ type: TransactionResponseDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR, INVALID_AMOUNT, IDEMPOTENCY_KEY_REQUIRED',
  })
  @ApiNotFoundResponse({ description: 'WALLET_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({ description: 'IDEMPOTENCY_KEY_REUSED' })
  async deposit(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body() dto: DepositDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransactionResponseDto> {
    return respond(res, await this.transactions.deposit(walletId, dto, key));
  }

  @Post('swaps')
  @ApiOperation({ summary: 'Swap one stablecoin for another inside the same wallet' })
  @IdempotencyHeaderDoc
  @ApiCreatedResponse({ type: TransactionResponseDto })
  @ApiOkResponse({ type: TransactionResponseDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR, SAME_CURRENCY_SWAP, INVALID_AMOUNT' })
  @ApiNotFoundResponse({ description: 'WALLET_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    description: 'INSUFFICIENT_FUNDS, AMOUNT_TOO_SMALL, IDEMPOTENCY_KEY_REUSED',
  })
  async swap(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body() dto: SwapDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransactionResponseDto> {
    return respond(res, await this.transactions.swap(walletId, dto, key));
  }

  @Post('transfers')
  @ApiOperation({
    summary: 'Send funds to another wallet, converting automatically if currencies differ',
  })
  @IdempotencyHeaderDoc
  @ApiCreatedResponse({ type: TransactionResponseDto })
  @ApiOkResponse({ type: TransactionResponseDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR, SELF_TRANSFER, INVALID_AMOUNT' })
  @ApiNotFoundResponse({ description: 'WALLET_NOT_FOUND (sender or receiver)' })
  @ApiUnprocessableEntityResponse({
    description: 'INSUFFICIENT_FUNDS, AMOUNT_TOO_SMALL, IDEMPOTENCY_KEY_REUSED',
  })
  async transfer(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body() dto: TransferDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransactionResponseDto> {
    return respond(res, await this.transactions.transfer(walletId, dto, key));
  }

  @Get('transactions')
  @ApiOperation({
    summary: "List a wallet's transactions, newest first, with pagination and filters",
  })
  @ApiOkResponse({ type: TransactionPageDto })
  @ApiNotFoundResponse({ description: 'WALLET_NOT_FOUND' })
  list(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionPageDto> {
    return this.transactions.list(walletId, query);
  }
}

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get(':transactionId')
  @ApiOperation({ summary: 'Fetch a single transaction by id' })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND' })
  get(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<TransactionResponseDto> {
    return this.transactions.get(transactionId);
  }
}
