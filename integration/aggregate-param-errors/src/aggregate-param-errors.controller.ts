import {
  AggregateParamErrors,
  ArgumentsHost,
  BadRequestException,
  Body,
  CanActivate,
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
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  PipeTransform,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createInvalidBatchIdBody } from './batch-raw-url.gate.js';

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

// Upper bound (inclusive) of the decimal range accepted by the batch routes.
const MAX_BATCH_VALUE = 2147483647;

// Strict decimal conversion shared by the batch routes: only non-empty values
// consisting solely of ASCII digits and converting to an integer between 0
// and 2147483647 (inclusive) are accepted. Scientific notation, hex, signs,
// whitespace padding and fractional input all fail; leading zeros convert
// normally ('004' -> 4).
function parseBatchValue(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed > MAX_BATCH_VALUE) {
    return null;
  }
  return parsed;
}

// An invalid batch id is not a parameter-validation error to be aggregated:
// it aborts the whole request immediately (before any item is inspected) with
// a plain single-message 400 body, so it must not be collected into the
// aggregated message array of the annotated route.
class InvalidBatchIdException extends HttpException {
  constructor() {
    super(createInvalidBatchIdBody(), HttpStatus.BAD_REQUEST);
  }
}

class BatchIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const parsed = parseBatchValue(value);
    if (parsed === null) {
      throw new InvalidBatchIdException();
    }
    return parsed;
  }
}

// The id is validated before any parameter pipe runs (guards execute ahead of
// pipes on annotated and unannotated routes alike), so an invalid id always
// aborts the request with the plain 'ID' 400 and no item is ever inspected -
// regardless of the order in which concurrent parameter pipes would settle.
@Injectable()
class BatchIdGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    isolationState.pipeCalls.push('ID');
    const request = context.switchToHttp().getRequest();
    const parsed = parseBatchValue(request.params?.id);
    if (parsed === null) {
      throw new InvalidBatchIdException();
    }
    return true;
  }
}

// Converts a repeatable `item` query key (`?item=2&item=4`) one element at a
// time, in appearance order. Conversion errors are aggregated and stay
// indexable (ITEM[0], ITEM[2], ...); `deny` is not a request-parameter error
// but a conflict that aborts the resolution immediately.
class BatchItemsPipe implements PipeTransform<
  string[] | string | undefined,
  number[]
> {
  transform(value: string[] | string | undefined): number[] {
    if (value === undefined) {
      // The key is entirely absent: one unindexed message, distinct from an
      // explicit empty value (which exists as element 0 and fails as ITEM[0]).
      isolationState.pipeCalls.push('ITEM');
      throw new BadRequestException(['ITEM']);
    }
    const items = Array.isArray(value) ? value : [value];
    const numbers: number[] = [];
    const messages: string[] = [];
    items.forEach((raw, index) => {
      isolationState.pipeCalls.push('ITEM');
      if (raw === 'deny') {
        // Non-request error: stop touching the remaining elements and abort
        // the whole parameter resolution; messages staged earlier are dropped.
        throw new ConflictException('DENIED');
      }
      const parsed = parseBatchValue(raw);
      if (parsed === null) {
        messages.push(`ITEM[${index}]`);
        return;
      }
      numbers.push(parsed);
    });
    if (messages.length > 0) {
      throw new BadRequestException(messages);
    }
    return numbers;
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

// Fail-fast counterpart used by the unannotated compatibility route: it stops
// at the first non-convertible element and throws one plain (single) error,
// mirroring the legacy short-circuit semantics of any ordinary parameter pipe.
class BatchItemsFailFastPipe implements PipeTransform<
  string[] | string | undefined,
  number[]
> {
  transform(value: string[] | string | undefined): number[] {
    if (value === undefined) {
      throw new BadRequestException('ITEM');
    }
    const items = Array.isArray(value) ? value : [value];
    const numbers: number[] = [];
    for (let index = 0; index < items.length; index++) {
      isolationState.pipeCalls.push('ITEM');
      const raw = items[index];
      if (raw === 'deny') {
        throw new ConflictException('DENIED');
      }
      const parsed = parseBatchValue(raw);
      if (parsed === null) {
        throw new BadRequestException(`ITEM[${index}]`);
      }
      numbers.push(parsed);
    }
    return numbers;
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

// Root-level controller for the repeatable-query-key batch routes. The marked
// route aggregates the per-element conversion feedback of a single request;
// the unannotated route keeps the legacy fail-fast short-circuit for contrast.
// On both routes an invalid id aborts the request immediately with a plain
// single-message 400 ('ID') before any item is inspected.
@Controller()
@UseGuards(BatchIdGuard)
export class BatchController {
  @AggregateParamErrors()
  @Get('batch/:id')
  public batch(
    @Param('id', new BatchIdPipe()) id: number,
    @Query('item', new BatchItemsPipe()) items: number[],
  ) {
    recordHandler('batch');
    return { id, items };
  }

  @Get('batch-plain/:id')
  public batchPlain(
    @Param('id', new BatchIdPipe()) id: number,
    @Query('item', new BatchItemsFailFastPipe()) items: number[],
  ) {
    recordHandler('batchPlain');
    return { id, items };
  }
}
