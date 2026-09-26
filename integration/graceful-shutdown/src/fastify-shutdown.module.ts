import {
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  NestInterceptor,
  PipeTransform,
  Query,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { Observable } from 'rxjs';

/**
 * Side-effect counters shared with the e2e specs. Every layer of the request
 * chain increments its counter, so a rejected request can be proven never to
 * have entered the chain.
 */
export const shutdownSideEffects = {
  guard: 0,
  pipe: 0,
  interceptor: 0,
  controller: 0,
  reset() {
    this.guard = 0;
    this.pipe = 0;
    this.interceptor = 0;
    this.controller = 0;
  },
};

@Injectable()
export class TrackingGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    shutdownSideEffects.guard++;
    return true;
  }
}

@Injectable()
export class TrackingPipe implements PipeTransform {
  transform(value: unknown) {
    shutdownSideEffects.pipe++;
    return value;
  }
}

@Injectable()
export class TrackingInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    shutdownSideEffects.interceptor++;
    return next.handle();
  }
}

@Controller()
export class FastifyShutdownController {
  @Get('work')
  work(@Query() _query: Record<string, string>) {
    shutdownSideEffects.controller++;
    return 'ok';
  }

  @Get('slow')
  async slow(@Query() _query: Record<string, string>) {
    shutdownSideEffects.controller++;
    await new Promise(resolve => setTimeout(resolve, 500));
    return 'ok';
  }

  @Get('throw')
  async throwError(@Query() _query: Record<string, string>) {
    shutdownSideEffects.controller++;
    await new Promise(resolve => setTimeout(resolve, 100));
    throw new Error('controller failure');
  }

  @Get('hang')
  async hang(@Query() _query: Record<string, string>) {
    shutdownSideEffects.controller++;
    await new Promise(() => {});
    return 'never';
  }
}

@Module({
  controllers: [FastifyShutdownController],
  providers: [
    { provide: APP_GUARD, useClass: TrackingGuard },
    { provide: APP_PIPE, useClass: TrackingPipe },
    { provide: APP_INTERCEPTOR, useClass: TrackingInterceptor },
  ],
})
export class FastifyShutdownModule {}
