import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { appCounters } from './app.controller.js';

/**
 * Deterministic shutdown probe exposed at "/graceful-probe".
 *
 * Modes, selectable either with "?mode=<mode>" or a "/<mode>" path segment:
 *
 * GET  slow   - simulates in-flight work ("delay" in ms, 500 by default) and
 *               returns "ok"
 * GET  error  - simulates in-flight work, then throws so the original
 *               exception status/body must survive a concurrent close
 * GET  stats  - reports the business counters without mutating them
 * POST echo   - increments the counters only once the full request body has
 *               been received, then echoes it back
 */
@Controller('graceful-probe')
export class GracefulProbeController {
  @Get()
  probeByQuery(
    @Query('mode') mode: string = 'slow',
    @Query('delay') delay?: string,
  ) {
    return this.dispatchGet(mode, delay);
  }

  @Get(':mode')
  probeByPath(@Param('mode') mode: string, @Query('delay') delay?: string) {
    return this.dispatchGet(mode, delay);
  }

  @Post()
  @HttpCode(201)
  probeEchoByQuery(@Body() body: unknown) {
    return this.echo(body);
  }

  @Post('echo')
  @HttpCode(201)
  probeEchoByPath(@Body() body: unknown) {
    return this.echo(body);
  }

  private dispatchGet(mode: string, delay?: string) {
    if (mode === 'stats') {
      // A stats read is not business work: it must not move the counters it
      // reports, otherwise the post-shutdown invariants could not be checked.
      return {
        handlerEntries: appCounters.handlerEntries,
        echoCount: appCounters.echoCount,
        cleanupCount: appCounters.cleanupCount,
      };
    }

    if (mode === 'error') {
      return this.fail(delay === undefined ? 100 : Number(delay));
    }

    return this.slow(delay === undefined ? 500 : Number(delay));
  }

  private async slow(ms: number) {
    appCounters.handlerEntries++;
    await new Promise(resolve => setTimeout(resolve, ms));
    return 'ok';
  }

  private async fail(ms: number) {
    appCounters.handlerEntries++;
    await new Promise(resolve => setTimeout(resolve, ms));
    throw new Error('boom');
  }

  private echo(body: unknown) {
    // Only reached once the request body has been fully received and parsed
    appCounters.handlerEntries++;
    appCounters.echoCount++;
    return body;
  }
}
