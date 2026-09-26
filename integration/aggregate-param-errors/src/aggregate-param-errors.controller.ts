import {
  AggregateParamErrors,
  ArgumentsHost,
  BadRequestException,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  NotFoundException,
  Param,
  PipeTransform,
  Query,
  UseFilters,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

export class NumberPipe implements PipeTransform<string, number> {
  public static calls: string[] = [];

  constructor(private readonly errorMessage: string) {}

  transform(value: string): number {
    NumberPipe.calls.push(this.errorMessage);
    const parsed = Number(value);
    if (Number.isNaN(parsed) || value.trim() === '') {
      throw new BadRequestException(this.errorMessage);
    }
    return parsed;
  }
}

export class NotFoundPipe implements PipeTransform<string, string> {
  public static calls = 0;

  transform(value: string): string {
    NotFoundPipe.calls++;
    if (value === 'missing') {
      throw new NotFoundException('NOT-FOUND');
    }
    return value;
  }
}

@Catch(BadRequestException)
export class MyParamFilter implements ExceptionFilter {
  public static received: Array<{
    status: number;
    message: unknown;
  }> = [];

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: BadRequestException, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    const responseBody = exception.getResponse() as { message: unknown };
    // Record every invocation so tests can assert the filter sees the
    // aggregated exception exactly once (never per-parameter exceptions).
    MyParamFilter.received.push({
      status: exception.getStatus(),
      message: responseBody.message,
    });
    const count = Array.isArray(responseBody.message)
      ? responseBody.message.length
      : 1;
    httpAdapter.reply(response, { code: 'PARAMS_INVALID', count }, 422);
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  public static received: Array<{ status: number; message: unknown }> = [];

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    const httpException = exception as HttpException;
    const status =
      typeof httpException?.getStatus === 'function'
        ? httpException.getStatus()
        : 500;
    const body =
      typeof httpException?.getResponse === 'function'
        ? httpException.getResponse()
        : { message: 'Internal server error' };
    AllExceptionsFilter.received.push({
      status,
      message: (body as { message?: unknown })?.message ?? body,
    });
    httpAdapter.reply(response, body, status);
  }
}

@Controller('p')
export class AggregateParamErrorsController {
  public static handlerCalls: Record<string, number> = {};

  public static reset() {
    AggregateParamErrorsController.handlerCalls = {};
    NumberPipe.calls = [];
    NotFoundPipe.calls = 0;
    MyParamFilter.received = [];
    AllExceptionsFilter.received = [];
  }

  private track(name: string) {
    AggregateParamErrorsController.handlerCalls[name] =
      (AggregateParamErrorsController.handlerCalls[name] ?? 0) + 1;
  }

  @AggregateParamErrors()
  @Get(':id')
  public aggregated(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    this.track('aggregated');
    return `${id},${limit}`;
  }

  @Get('legacy/:id')
  public legacy(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    this.track('legacy');
    return `${id},${limit}`;
  }

  @AggregateParamErrors()
  @UseFilters(MyParamFilter)
  @Get('filtered/:id')
  public filtered(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    this.track('filtered');
    return `${id},${limit}`;
  }

  @AggregateParamErrors()
  @Get('other/:id')
  public other(
    @Param('id', new NotFoundPipe()) id: string,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    this.track('other');
    return `${id},${limit}`;
  }

  @AggregateParamErrors()
  @UseFilters(AllExceptionsFilter)
  @Get('any/:id')
  public any(
    @Param('id', new NotFoundPipe()) id: string,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    this.track('any');
    return `${id},${limit}`;
  }
}
