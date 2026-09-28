import { Module, OnModuleDestroy } from '@nestjs/common';
import { AppController, appCounters } from './app.controller.js';
import { GracefulWsGateway } from './graceful-ws.gateway.js';

@Module({
  controllers: [AppController],
  providers: [GracefulWsGateway],
})
export class AppModule implements OnModuleDestroy {
  onModuleDestroy() {
    appCounters.cleanupCount++;
  }
}
