import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * One error shape for every failure: { statusCode, error, message, errors?, requestId }.
 * Unexpected errors never leak internals; the stack is logged with the request id instead.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = req.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const base = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      const message = Array.isArray(base.message) ? base.message.join('; ') : (base.message ?? exception.message);
      res.status(status).json({
        statusCode: status,
        error: (base.error as string | undefined) ?? HttpStatus[status] ?? 'Error',
        message,
        ...(base.errors ? { errors: base.errors } : {}),
        ...(base.code ? { code: base.code } : {}),
        requestId,
      });
      return;
    }

    // Errors raised by the request parser (body too large, malformed body) carry their own 4xx status.
    const parsed = exception as { status?: unknown; type?: unknown; expose?: unknown };
    if (typeof parsed.status === 'number' && parsed.status >= 400 && parsed.status < 500 && parsed.expose === true) {
      const message = parsed.status === 413 ? 'That request is too large.' : 'The request could not be read.';
      res.status(parsed.status).json({ statusCode: parsed.status, error: HttpStatus[parsed.status] ?? 'Error', message, code: parsed.status === 413 ? 'too_large' : 'bad_request', requestId });
      return;
    }

    this.log.error(`Unhandled error [${requestId ?? '-'}] ${req.method} ${req.originalUrl}`, exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ statusCode: 500, error: 'Internal Server Error', message: 'Something went wrong on our side. Please try again.', requestId });
  }
}
