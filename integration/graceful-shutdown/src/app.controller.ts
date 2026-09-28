import { Body, Controller, Get, Post, Query } from '@nestjs/common';

/**
 * Mutable counters so that e2e tests can observe how far requests travelled
 * into the Nest pipeline and how many times shutdown cleanup ran.
 */
export const appCounters = {
  /** Requests that reached a route handler. */
  handlerEntries: 0,
  /** "/echo" invocations, incremented only once the full body was received. */
  echoCount: 0,
  /** Module cleanup ("onModuleDestroy") executions. */
  cleanupCount: 0,
};

export function resetAppCounters() {
  appCounters.handlerEntries = 0;
  appCounters.echoCount = 0;
  appCounters.cleanupCount = 0;
}

@Controller()
export class AppController {
  @Get('slow')
  async slow(@Query('delay') delay?: string) {
    appCounters.handlerEntries++;
    // Simulate work; the delay is configurable via the "delay" query param
    const ms = delay === undefined ? 500 : Number(delay);
    await new Promise(resolve => setTimeout(resolve, ms));
    return 'ok';
  }

  @Get('error')
  async error() {
    appCounters.handlerEntries++;
    // Simulate work before failing, so tests can shut down mid-flight
    await new Promise(resolve => setTimeout(resolve, 100));
    throw new Error('boom');
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    // Only reached once the request body has been fully received and parsed
    appCounters.handlerEntries++;
    appCounters.echoCount++;
    return body;
  }

  /**
   * Single endpoint bundling the probe behaviors the shutdown gate can be
   * observed through, independent of the route shape:
   * - GET  ?mode=slow   resolves with "ok" after "delay" ms (default 500)
   * - GET  ?mode=error  throws a business error after "delay" ms
   * - GET  ?mode=stats  reports the shared counters without disturbing them
   * - POST ?mode=echo   increments the counters only once the full body was
   *                     received and echoes the parsed body back
   */
  @Get('graceful-probe')
  async gracefulProbe(
    @Query('mode') mode?: string,
    @Query('delay') delay?: string,
  ) {
    if (mode === 'stats') {
      return { ...appCounters };
    }
    appCounters.handlerEntries++;
    const ms = delay === undefined ? 500 : Number(delay);
    await new Promise(resolve => setTimeout(resolve, ms));
    if (mode === 'error') {
      throw new Error('boom');
    }
    return 'ok';
  }

  @Post('graceful-probe')
  gracefulProbeEcho(@Query('mode') mode: string, @Body() body: unknown) {
    // Only reached once the request body has been fully received and parsed
    appCounters.handlerEntries++;
    if (mode === 'echo') {
      appCounters.echoCount++;
    }
    return body;
  }
}
