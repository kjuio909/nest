import {
  BeforeApplicationShutdown,
  Module,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { AppController } from './app.controller.js';

/**
 * Lifecycle hook invocations the graceful-shutdown tests can observe to
 * verify that the cleanup runs exactly once per shutdown cycle.
 */
export const cleanupCounters = {
  onModuleDestroy: 0,
  beforeApplicationShutdown: 0,
  onApplicationShutdown: 0,
};

export const resetCleanupCounters = () => {
  cleanupCounters.onModuleDestroy = 0;
  cleanupCounters.beforeApplicationShutdown = 0;
  cleanupCounters.onApplicationShutdown = 0;
};

@Module({
  controllers: [AppController],
})
export class AppModule
  implements OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown
{
  onModuleDestroy() {
    cleanupCounters.onModuleDestroy++;
  }

  beforeApplicationShutdown() {
    cleanupCounters.beforeApplicationShutdown++;
  }

  onApplicationShutdown() {
    cleanupCounters.onApplicationShutdown++;
  }
}
