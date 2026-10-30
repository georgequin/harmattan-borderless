import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiError } from './errors';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  path: string;
  timestamp: string;
}

/** Renders every error in one consistent shape and never leaks internals on 500s. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const body: ErrorBody = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      path: req.url,
      timestamp: new Date().toISOString(),
    };

    if (exception instanceof ApiError) {
      body.statusCode = exception.getStatus();
      body.code = exception.code;
      body.message = exception.message;
      body.details = exception.details;
    } else if (exception instanceof HttpException) {
      body.statusCode = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'object' && response !== null && 'message' in response
          ? (response as { message: unknown }).message
          : exception.message;
      if (Array.isArray(message)) {
        body.code = 'VALIDATION_ERROR';
        body.message = 'Request validation failed';
        body.details = { errors: message };
      } else {
        body.code = HttpStatus[body.statusCode] ?? 'HTTP_ERROR';
        body.message = String(message);
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(body.statusCode).json(body);
  }
}
