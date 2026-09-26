import { Module, OnModuleDestroy } from '@nestjs/common';
import { AppController, appCounters } from './app.controller.js';

@Module({
  controllers: [AppController],
})
export class AppModule implements OnModuleDestroy {
  onModuleDestroy() {
    appCounters.cleanupCount++;
  }
}
