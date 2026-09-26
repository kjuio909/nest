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
}
