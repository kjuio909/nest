import {
  AggregateParamErrors,
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  ConflictException,
  Controller,
  createParamDecorator,
  DefaultValuePipe,
  ExecutionContext,
  ExceptionFilter,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  PipeTransform,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/**
 * Per-process counters used by the request-isolation suites. The aggregation
 * state itself is per-request; these counters only let tests observe how many
 * pipes/handlers ran for a sequence of requests. They are reset in every test's
 * beforeEach via {@link resetIsolationState}.
 */
export const isolationState: {
  pipeCalls: string[];
  handlerCalls: Record<string, number>;
} = {
  pipeCalls: [],
  handlerCalls: {},
};

export function resetIsolationState(): void {
  isolationState.pipeCalls = [];
  isolationState.handlerCalls = {};
  MyParamFilter.received = [];
  MyWideFilter.last = null;
}

function recordHandler(name: string): void {
  isolationState.handlerCalls[name] =
    (isolationState.handlerCalls[name] ?? 0) + 1;
}

class NumberPipe implements PipeTransform<string, number> {
  constructor(private readonly errorMessage: string) {}

  transform(value: string): number {
    isolationState.pipeCalls.push(this.errorMessage);
    const parsed = Number(value);
    if (Number.isNaN(parsed) || value.trim() === '') {
      throw new BadRequestException(this.errorMessage);
    }
    return parsed;
  }
}

class SlowNumberPipe implements PipeTransform<
  string,
  Promise<number> | number
> {
  constructor(
    private readonly errorMessage: string,
    private readonly delayMs: number,
  ) {}

  async transform(value: string): Promise<number> {
    isolationState.pipeCalls.push(this.errorMessage);
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const parsed = Number(value);
    if (Number.isNaN(parsed) || value.trim() === '') {
      throw new BadRequestException(this.errorMessage);
    }
    return parsed;
  }
}

// The limit chain runs after a DefaultValuePipe, so its input is either the
// raw query string or the seeded default number. Explicit invalid values must
// fail the chain (LIMIT) instead of silently falling back to the default.
class LimitPipe implements PipeTransform<string | number, number> {
  transform(value: string | number): number {
    isolationState.pipeCalls.push('LIMIT');
    if (typeof value === 'string' && value.trim() === '') {
      throw new BadRequestException('LIMIT');
    }
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new BadRequestException('LIMIT');
    }
    return parsed;
  }
}

class SlowLimitPipe implements PipeTransform<
  string | number,
  Promise<number> | number
> {
  constructor(private readonly delayMs: number) {}

  async transform(value: string | number): Promise<number> {
    isolationState.pipeCalls.push('LIMIT');
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (typeof value === 'string' && value.trim() === '') {
      throw new BadRequestException('LIMIT');
    }
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new BadRequestException('LIMIT');
    }
    return parsed;
  }
}

// `currency` is a required query parameter: a missing or blank value is a
// request error (CURRENCY), never masked by the optional `limit` default.
class CurrencyPipe implements PipeTransform<string | undefined, string> {
  transform(value: string | undefined): string {
    isolationState.pipeCalls.push('CURRENCY');
    if (value === undefined || value.trim() === '') {
      throw new BadRequestException('CURRENCY');
    }
    return value.toUpperCase();
  }
}

class NotFoundPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    isolationState.pipeCalls.push('N');
    if (value === 'missing') {
      throw new NotFoundException('NOT-FOUND');
    }
    return value;
  }
}

class PartialAbortPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    isolationState.pipeCalls.push('M');
    if (value === 'abort') {
      // A non-BadRequest HttpException: aggregation must abort immediately and
      // the default exception layer keeps its regular status/body path.
      throw new ForbiddenException('ABORTED');
    }
    return value;
  }
}

class BodyPipe implements PipeTransform<any, any> {
  transform(body: any): any {
    isolationState.pipeCalls.push('BODY');
    if (!body || body.valid !== true) {
      throw new BadRequestException('BODY');
    }
    return { ...body, transformed: true };
  }
}

class CustomUserPipe implements PipeTransform<any, any> {
  transform(user: any): any {
    isolationState.pipeCalls.push('CUSTOM');
    if (!user || user.ok !== true) {
      throw new BadRequestException('CUSTOM');
    }
    return user;
  }
}

class HeaderNumberPipe implements PipeTransform<string | undefined, number> {
  transform(value: string | undefined): number {
    isolationState.pipeCalls.push('H');
    const parsed = Number(value);
    if (
      value === undefined ||
      String(value).trim() === '' ||
      Number.isNaN(parsed)
    ) {
      throw new BadRequestException('H');
    }
    return parsed;
  }
}

class HeaderAbortPipe implements PipeTransform<string | undefined, string> {
  transform(value: string | undefined): string {
    isolationState.pipeCalls.push('HF');
    if (value === 'abort') {
      // A non-BadRequest exception raised by a header pipe: aggregation must
      // abort immediately and the staged param/query messages are discarded.
      throw new ForbiddenException('HEADER-ABORT');
    }
    return value ?? '';
  }
}

// Converts the repeatable `item` query key element by element, in order of
// appearance. Every element is checked even after a failure: invalid elements
// are collected with their original position (`ITEM[<index>]`) and rethrown as
// a single BadRequestException once the whole list was inspected. A missing
// key is reported as `ITEM`; an explicitly empty element is present but
// invalid (`ITEM[0]`), never masked by the missing-key rule. The sentinel
// value `deny` is not a request-parameter error: it aborts the conversion
// immediately with a 409 and discards every message staged so far.
class BatchItemsPipe implements PipeTransform<
  string | string[] | undefined,
  number[]
> {
  transform(value: string | string[] | undefined): number[] {
    isolationState.pipeCalls.push('ITEM');
    if (value === undefined) {
      throw new BadRequestException('ITEM');
    }
    const values = Array.isArray(value) ? value : [value];
    const items: number[] = [];
    const messages: string[] = [];
    values.forEach((raw, position) => {
      if (raw === 'deny') {
        throw new ConflictException('DENIED');
      }
      const parsed = Number(raw);
      if (String(raw).trim() === '' || Number.isNaN(parsed)) {
        messages.push(`ITEM[${position}]`);
        return;
      }
      items.push(parsed);
    });
    if (messages.length > 0) {
      throw new BadRequestException(messages);
    }
    return items;
  }
}

// Fail-fast counterpart of {@link BatchItemsPipe} for the unmarked
// compatibility route: the first invalid element stops the conversion and its
// message is the response body (a string, never an array).
class FailFastItemsPipe implements PipeTransform<
  string | string[] | undefined,
  number[]
> {
  transform(value: string | string[] | undefined): number[] {
    isolationState.pipeCalls.push('ITEM');
    if (value === undefined) {
      throw new BadRequestException('ITEM');
    }
    const values = Array.isArray(value) ? value : [value];
    return values.map((raw, position) => {
      if (raw === 'deny') {
        throw new ConflictException('DENIED');
      }
      const parsed = Number(raw);
      if (String(raw).trim() === '' || Number.isNaN(parsed)) {
        throw new BadRequestException(`ITEM[${position}]`);
      }
      return parsed;
    });
  }
}

const User = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const name = request.headers['x-user'];
  return name ? { name, ok: true } : { ok: false };
});

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
export class MyWideFilter implements ExceptionFilter {
  public static last: { name: string; status?: number } | null = null;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    MyWideFilter.last = {
      name: (exception as Error)?.name,
      status:
        typeof (exception as { getStatus?: () => number })?.getStatus ===
        'function'
          ? (exception as { getStatus: () => number }).getStatus()
          : undefined,
    };
    httpAdapter.reply(response, { code: 'WIDE' }, 418);
  }
}

@Controller('p')
export class AggregateParamErrorsController {
  @AggregateParamErrors()
  @Get(':id')
  public aggregated(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('aggregated');
    return `${id},${limit}`;
  }

  @Get('legacy/:id')
  public legacy(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('legacy');
    return `${id},${limit}`;
  }

  @AggregateParamErrors()
  @UseFilters(MyParamFilter)
  @Get('filtered/:id')
  public filtered(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('filtered');
    return `${id},${limit}`;
  }

  @AggregateParamErrors()
  @Get('other/:id')
  public other(
    @Param('id', new NotFoundPipe()) id: string,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('other');
    return `${id},${limit}`;
  }

  // The first @Param() fails with a BadRequest (collected), the second
  // @Param() aborts with a non-BadRequest error: the partially collected
  // message must die with this request.
  @AggregateParamErrors()
  @Get('partial/:id/:mode')
  public partial(
    @Param('id', new NumberPipe('A')) id: number,
    @Param('mode', new PartialAbortPipe()) mode: string,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('partial');
    return `${id},${mode},${limit}`;
  }

  // Delayed param pipe used to keep a valid and an invalid request genuinely
  // in flight at the same time in the parallel tests.
  @AggregateParamErrors()
  @Get('slow/:id')
  public slow(
    @Param('id', new SlowNumberPipe('A', 30)) id: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('slow');
    return `${id},${limit}`;
  }

  // @Body() must stay outside the aggregation scope: its pipe error aborts
  // immediately even when a @Param() failed first.
  @AggregateParamErrors()
  @Post('body/:id')
  public withBody(
    @Param('id', new NumberPipe('A')) id: number,
    @Body(new BodyPipe()) body: { transformed: boolean },
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('body');
    return `${id},${limit},${body.transformed ? 'transformed' : 'raw'}`;
  }

  // Custom parameter extractors must keep the existing (fail-fast) scope.
  @AggregateParamErrors()
  @Get('custom/:id')
  public withCustom(
    @Param('id', new NumberPipe('A')) id: number,
    @User(new CustomUserPipe()) user: { name: string },
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('custom');
    return `${id},${limit},${user.name}`;
  }

  // @Headers() parameters are an independent input domain: the header pipe
  // always runs and its transformed value reaches the handler, but a header
  // failure aborts the resolution immediately and discards any @Param()/
  // @Query() messages collected so far.
  @AggregateParamErrors()
  @Get('headers/:id')
  public withHeaders(
    @Param('id', new NumberPipe('A')) id: number,
    @Headers('x-token', new HeaderNumberPipe()) token: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('headers');
    return `${id},${token},${limit}`;
  }

  // The filter must observe only the header exception when the header pipe
  // fails - never the staged @Param()/@Query() messages.
  @AggregateParamErrors()
  @UseFilters(MyParamFilter)
  @Get('headers-filtered/:id')
  public withHeadersFiltered(
    @Param('id', new NumberPipe('A')) id: number,
    @Headers('x-token', new HeaderNumberPipe()) token: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('headersFiltered');
    return `${id},${token},${limit}`;
  }

  // A non-BadRequest header exception propagates unchanged through the
  // catch-all filter; the staged param/query messages die with the request.
  @AggregateParamErrors()
  @UseFilters(MyWideFilter)
  @Get('headers-wide/:id')
  public withHeadersWide(
    @Param('id', new NumberPipe('A')) id: number,
    @Headers('x-mode', new HeaderAbortPipe()) mode: string,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('headersWide');
    return `${id},${mode},${limit}`;
  }

  // Unannotated route with a header pipe: the header pipe runs, but the
  // fail-fast compatibility path is unchanged.
  @Get('headers-legacy/:id')
  public withHeadersLegacy(
    @Param('id', new NumberPipe('A')) id: number,
    @Headers('x-token', new HeaderNumberPipe()) token: number,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('headersLegacy');
    return `${id},${token},${limit}`;
  }

  // Delayed pipes on all three domains, used to keep mixed-failure requests
  // genuinely in flight at the same time in the parallel tests.
  @AggregateParamErrors()
  @Get('headers-slow/:id')
  public withHeadersSlow(
    @Param('id', new SlowNumberPipe('A', 30)) id: number,
    @Headers('x-token', new SlowNumberPipe('H', 30)) token: number,
    @Query('limit', new SlowNumberPipe('B', 30)) limit: number,
  ) {
    recordHandler('headersSlow');
    return `${id},${token},${limit}`;
  }

  // A catch-all method filter must receive the original non-request exception
  // unchanged (not the aggregated BadRequest).
  @AggregateParamErrors()
  @UseFilters(MyWideFilter)
  @Get('wide/:id')
  public wide(
    @Param('id', new NotFoundPipe()) id: string,
    @Query('limit', new NumberPipe('B')) limit: number,
  ) {
    recordHandler('wide');
    return `${id},${limit}`;
  }

  // Optional query value with a per-resolution default: when `limit` is
  // absent, DefaultValuePipe seeds 10 which still runs through the same
  // LimitPipe conversion as an explicit value. An explicit invalid value
  // must fail (LIMIT), never fall back to 10. `currency` is required.
  @AggregateParamErrors()
  @Get('defaults/:id')
  public defaults(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('currency', new CurrencyPipe()) currency: string,
    @Query('limit', new DefaultValuePipe(10), new LimitPipe())
    limit: number,
  ) {
    recordHandler('defaults');
    return { id, currency, limit };
  }

  // Delayed variant of the defaults route used to keep a default-success and
  // an explicit-invalid request genuinely in flight in the parallel tests.
  @AggregateParamErrors()
  @Get('defaults-slow/:id')
  public defaultsSlow(
    @Param('id', new SlowNumberPipe('A', 30)) id: number,
    @Query('currency', new CurrencyPipe()) currency: string,
    @Query('limit', new DefaultValuePipe(10), new SlowLimitPipe(30))
    limit: number,
  ) {
    recordHandler('defaultsSlow');
    return { id, currency, limit };
  }
}

@Controller('batch')
export class AggregateParamErrorsBatchController {
  // Batch route: the repeatable `item` query key is converted element by
  // element and the handler runs once, only when every element converted.
  // The response keeps the array shape even for a single value.
  @AggregateParamErrors()
  @Get(':id')
  public batch(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('item', new BatchItemsPipe()) items: number[],
  ) {
    recordHandler('batch');
    return { id, items };
  }

  // Unmarked compatibility route: same inputs, but the conversion stops at
  // the first failing element and the response keeps the single-error body.
  @Get('legacy/:id')
  public batchLegacy(
    @Param('id', new NumberPipe('A')) id: number,
    @Query('item', new FailFastItemsPipe()) items: number[],
  ) {
    recordHandler('batchLegacy');
    return { id, items };
  }
}
