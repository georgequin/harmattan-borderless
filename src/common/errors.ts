import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain error with a stable machine-readable code. Clients should branch on
 * `code`, never on `message`.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  walletNotFound: (walletId: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'WALLET_NOT_FOUND', `Wallet ${walletId} not found`),
  transactionNotFound: (id: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'TRANSACTION_NOT_FOUND', `Transaction ${id} not found`),
  walletExists: (field: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'WALLET_ALREADY_EXISTS',
      `A wallet with this ${field} already exists`,
      { field },
    ),
  insufficientFunds: (currency: string, available: string, requested: string) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'INSUFFICIENT_FUNDS',
      `Insufficient ${currency} balance`,
      { currency, available, requested },
    ),
  amountTooSmall: () =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'AMOUNT_TOO_SMALL',
      'Amount converts to less than the smallest unit (0.000001) of the destination currency',
    ),
  amountTooLarge: (max: string) =>
    new ApiError(HttpStatus.BAD_REQUEST, 'AMOUNT_TOO_LARGE', `Amount must not exceed ${max}`),
  invalidAmount: (message: string) =>
    new ApiError(HttpStatus.BAD_REQUEST, 'INVALID_AMOUNT', message),
  sameCurrencySwap: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'SAME_CURRENCY_SWAP',
      'fromCurrency and toCurrency must differ',
    ),
  selfTransfer: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'SELF_TRANSFER',
      'Cannot transfer to the same wallet; use a swap to change currency',
    ),
  idempotencyKeyMissing: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Header Idempotency-Key is required (8-128 chars of A-Z a-z 0-9 _ - : .)',
    ),
  idempotencyKeyReused: () =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request',
    ),
};
