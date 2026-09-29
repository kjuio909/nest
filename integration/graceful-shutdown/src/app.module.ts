import { Module, OnModuleDestroy } from '@nestjs/common';
import { AppController, appCounters } from './app.controller.js';
import { GracefulWsStatsController } from './graceful-ws.controller.js';
import { GracefulWsGateway } from './graceful-ws.gateway.js';

@Module({
  controllers: [AppController, GracefulWsStatsController],
  providers: [GracefulWsGateway],
})
export class AppModule implements OnModuleDestroy {
  onModuleDestroy() {
    appCounters.cleanupCount++;
  }
}
