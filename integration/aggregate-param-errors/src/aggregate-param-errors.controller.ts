import {
  AggregateParamErrors,
  ArgumentsHost,
  BadRequestException,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Injectable,
  Param,
  PipeTransform,
  Query,
  UseFilters,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Injectable()
export class IdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('A');
    }
    return Number(value);
  }
}

@Injectable()
export class LimitPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('B');
    }
    return Number(value);
  }
}

@Catch(BadRequestException)
export class MyParamFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const response = host.switchToHttp().getResponse();
    const message = (exception.getResponse() as { message: unknown }).message;

    // The filter only ever sees the aggregated exception: when several
    // parameter pipes fail, `message` is the collected array.
    httpAdapter.reply(
      response,
      {
        code: 'PARAMS_INVALID',
        count: Array.isArray(message) ? message.length : 1,
      },
      422,
    );
  }
}

@Controller('p')
export class AggregateParamErrorsController {
  @AggregateParamErrors()
  @Get(':id')
  public findOne(
    @Param('id', IdPipe) id: number,
    @Query('limit', LimitPipe) limit: number,
  ): string {
    return `${id},${limit}`;
  }

  @AggregateParamErrors()
  @UseFilters(MyParamFilter)
  @Get('filtered/:id')
  public filtered(
    @Param('id', IdPipe) id: number,
    @Query('limit', LimitPipe) limit: number,
  ): string {
    return `${id},${limit}`;
  }

  // No @AggregateParamErrors(): keeps the existing fail-fast behavior.
  @Get('legacy/:id')
  public legacy(
    @Param('id', IdPipe) id: number,
    @Query('limit', LimitPipe) limit: number,
  ): string {
    return `${id},${limit}`;
  }
}
