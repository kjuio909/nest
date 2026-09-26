import {
  AggregateParamErrors,
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  createParamDecorator,
  ExecutionContext,
  ExceptionFilter,
  ForbiddenException,
  Get,
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
}
