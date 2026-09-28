import { Module, OnModuleDestroy } from '@nestjs/common';
import { AppController, appCounters } from './app.controller.js';
import { GracefulProbeController } from './graceful-probe.controller.js';

@Module({
  controllers: [AppController, GracefulProbeController],
})
export class AppModule implements OnModuleDestroy {
  onModuleDestroy() {
    appCounters.cleanupCount++;
  }
}
