import { Controller, Get } from '@nestjs/common';
import { wsCounters } from './graceful-ws.gateway.js';

/**
 * Read-only statistics for the "/graceful-ws" probe.
 *
 * A stats read is not business work: it never mutates the counters it
 * reports. After the application has closed (and the listening socket is
 * gone) the same figures remain readable in-process via "wsCounters",
 * without accepting any new HTTP or WebSocket traffic.
 */
@Controller('graceful-ws')
export class GracefulWsStatsController {
  @Get('stats')
  getStats() {
    return {
      activeConnections: wsCounters.activeConnections,
      completedMessages: wsCounters.completedMessages,
      cleanupCount: wsCounters.cleanupCount,
    };
  }
}
