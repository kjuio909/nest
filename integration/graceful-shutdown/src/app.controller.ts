import { Body, Controller, Get, Post, Query } from '@nestjs/common';

/**
 * Side-effect counters the graceful-shutdown tests can observe: how often a
 * handler was entered and how often a fully received body was echoed back.
 */
export const appCounters = {
  handlerEntries: 0,
  echo: 0,
};

export const resetAppCounters = () => {
  appCounters.handlerEntries = 0;
  appCounters.echo = 0;
};

@Controller()
export class AppController {
  @Get('slow')
  async slow(@Query('delay') delay?: string) {
    appCounters.handlerEntries++;
    // Simulate work; the delay is configurable via "?delay=<ms>"
    await new Promise(resolve =>
      setTimeout(resolve, delay === undefined ? 500 : Number(delay)),
    );
    return 'ok';
  }

  @Get('error')
  async error() {
    appCounters.handlerEntries++;
    await new Promise(resolve => setTimeout(resolve, 100));
    throw new Error('boom');
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    // Reached only once the request body has been received in full
    appCounters.echo++;
    return body;
  }
}
