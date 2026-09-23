import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
} from '@nestjs/common';
import {
  LazyModuleLoader,
  ModuleRef,
  ModulesContainer,
  NestContainer,
} from '../../../injector/index.js';
import {
  callModuleBootstrapHook,
  callModuleInitHook,
} from '../../../hooks/index.js';
import { Injector } from '../../../injector/injector.js';
import { InstanceLoader } from '../../../injector/instance-loader.js';
import { GraphInspector } from '../../../inspector/graph-inspector.js';
import { MetadataScanner } from '../../../metadata-scanner.js';
import { NestFactory } from '../../../nest-factory.js';
import { DependenciesScanner } from '../../../scanner.js';

describe('LazyModuleLoader', () => {
  let lazyModuleLoader: LazyModuleLoader;
  let dependenciesScanner: DependenciesScanner;
  let instanceLoader: InstanceLoader;
  let modulesContainer: ModulesContainer;

  class NoopLogger {
    log() {}
    error() {}
    warn() {}
  }

  beforeEach(() => {
    const nestContainer = new NestContainer();
    const graphInspector = new GraphInspector(nestContainer);
    dependenciesScanner = new DependenciesScanner(
      nestContainer,
      new MetadataScanner(),
      graphInspector,
    );

    const injector = new Injector();
    instanceLoader = new InstanceLoader(
      nestContainer,
      injector,
      graphInspector,
      new NoopLogger(),
    );
    modulesContainer = nestContainer.getModules();
    lazyModuleLoader = new LazyModuleLoader(
      dependenciesScanner,
      instanceLoader,
      nestContainer['moduleCompiler'],
      modulesContainer,
    );
  });
  describe('load', () => {
    const bProvider = { provide: 'B', useValue: 'B' };

    @Module({ providers: [bProvider], exports: [bProvider] })
    class ModuleB {}

    @Module({ imports: [ModuleB] })
    class ModuleA {}

    describe('when module was not loaded yet', () => {
      it('should load it and return a module reference', async () => {
        const moduleRef = await lazyModuleLoader.load(() => ModuleA);
        expect(moduleRef).toBeInstanceOf(ModuleRef);
        expect(moduleRef.get(bProvider.provide, { strict: false })).toBe(
          bProvider.useValue,
        );
      });
    });
    describe('when module was loaded already', () => {
      @Module({})
      class ModuleC {}

      it('should return an existing module reference', async () => {
        const moduleRef = await lazyModuleLoader.load(() => ModuleC);
        const moduleRef2 = await lazyModuleLoader.load(() => ModuleC);
        expect(moduleRef).toBe(moduleRef2);
      });
    });

    describe('when logger option is false', () => {
      @Module({})
      class ModuleWithLogA {}

      @Module({})
      class ModuleWithLogB {}

      it('should not permanently silence logs for subsequent load() calls', async () => {
        const logger = instanceLoader['logger'];
        const logSpy = vitest.spyOn(logger, 'log');

        await lazyModuleLoader.load(() => ModuleWithLogA, { logger: false });
        expect(logSpy).not.toHaveBeenCalled();

        await lazyModuleLoader.load(() => ModuleWithLogB);
        expect(logSpy).toHaveBeenCalled();
      });
    });

    describe('singleton sharing and repeated loading (#17428)', () => {
      let constructionsCount = 0;
      let globalConstructionsCount = 0;

      @Injectable()
      class SharedService {
        constructor() {
          constructionsCount++;
        }
      }

      @Module({
        providers: [SharedService],
        exports: [SharedService],
      })
      class SharedModule {}

      @Global()
      @Module({
        providers: [
          {
            provide: 'GlobalService',
            useFactory: () => {
              globalConstructionsCount++;
              return 'global';
            },
          },
        ],
        exports: ['GlobalService'],
      })
      class GlobalSharedModule {}

      @Injectable()
      class Consumer {
        constructor(readonly shared: SharedService) {}
      }

      @Module({
        imports: [SharedModule],
        providers: [Consumer],
      })
      class LazyModule {}

      @Module({
        providers: [
          {
            provide: 'GlobalConsumer',
            useFactory: (globalService: any) => globalService,
            inject: ['GlobalService'],
          },
        ],
      })
      class LazyGlobalModule {}

      @Module({
        imports: [SharedModule, GlobalSharedModule],
      })
      class EagerModule {}

      let eagerSharedService: SharedService;

      beforeEach(async () => {
        constructionsCount = 0;
        globalConstructionsCount = 0;

        // Boot the eager graph
        await dependenciesScanner.scan(EagerModule);
        await instanceLoader.createInstancesOfDependencies();

        const { token: sharedModuleToken } = await (
          lazyModuleLoader as any
        ).moduleCompiler.compile(SharedModule);
        const sharedModuleInstance = modulesContainer.get(sharedModuleToken)!;
        eagerSharedService =
          sharedModuleInstance.getProviderByKey(SharedService).instance;
      });

      it('should share already-initialized singleton providers with lazily-loaded consumer', async () => {
        const lazyModuleRef = await lazyModuleLoader.load(() => LazyModule);
        const lazyConsumer = lazyModuleRef.get(Consumer);
        expect(lazyConsumer.shared).toBe(eagerSharedService);
        expect(constructionsCount).toBe(1);
      });

      it('should not construct the provider again on repeated load() calls', async () => {
        await lazyModuleLoader.load(() => LazyModule);
        expect(constructionsCount).toBe(1);

        await lazyModuleLoader.load(() => LazyModule);
        expect(constructionsCount).toBe(1);
      });

      it('should correctly support global modules without duplicating constructor calls', async () => {
        const lazyGlobalRef = await lazyModuleLoader.load(
          () => LazyGlobalModule,
        );
        const globalConsumer = lazyGlobalRef.get('GlobalConsumer', {
          strict: false,
        });
        expect(globalConsumer).toBe('global');
        expect(globalConstructionsCount).toBe(1);

        await lazyModuleLoader.load(() => LazyGlobalModule);
        expect(globalConstructionsCount).toBe(1);
      });
    });

    describe('dynamic modules with pre-registered dynamic imports (#17462)', () => {
      // The import must itself be a `DynamicModule` object: those are
      // pre-registered by `NestContainer#addDynamicMetadata` before the lazy
      // scan reaches them, so they look "already registered" to the scanner.
      @Module({
        providers: [{ provide: 'ITEMS', useValue: ['itemA', 'itemB'] }],
        exports: ['ITEMS'],
      })
      class ChildProviderModule {}

      @Injectable()
      class ParentService {
        constructor(@Inject('ITEMS') readonly items: string[]) {}
      }

      @Module({ providers: [ParentService], exports: [ParentService] })
      class ParentRootModule {}

      @Module({
        providers: [{ provide: 'GLOBAL_DEP', useValue: 'globalDep' }],
        exports: ['GLOBAL_DEP'],
      })
      @Global()
      class GlobalDepModule {}

      @Module({
        providers: [
          {
            provide: 'CHILD_OUT',
            useFactory: (dep: string) => `child(${dep})`,
            inject: ['GLOBAL_DEP'],
          },
        ],
        exports: ['CHILD_OUT'],
      })
      class ChildNeedsGlobalModule {}

      @Injectable()
      class GlobalHuskConsumer {
        constructor(@Inject('CHILD_OUT') readonly childOut: string) {}
      }

      @Module({
        providers: [GlobalHuskConsumer],
        exports: [GlobalHuskConsumer],
      })
      class GlobalHuskRootModule {}

      @Module({ imports: [GlobalDepModule] })
      class AppModule {}

      beforeEach(async () => {
        await dependenciesScanner.scan(AppModule);
        await instanceLoader.createInstancesOfDependencies();
      });

      it('should scan dynamic imports declared in the dynamic metadata', async () => {
        // Arrange
        const child: DynamicModule = { module: ChildProviderModule };
        const definition: DynamicModule = {
          module: ParentRootModule,
          imports: [child],
          exports: [child],
        };

        // Act
        const moduleRef = await lazyModuleLoader.load(() => definition);

        // Assert
        expect(moduleRef.get(ParentService).items).toEqual([
          'itemA',
          'itemB',
        ]);
      });

      it('should keep the module resolvable on repeated load() calls', async () => {
        // Arrange
        const child: DynamicModule = { module: ChildProviderModule };
        const definition: DynamicModule = {
          module: ParentRootModule,
          imports: [child],
          exports: [child],
        };

        // Act
        const first = await lazyModuleLoader.load(() => definition);
        const second = await lazyModuleLoader.load(() => definition);

        // Assert
        expect(first).toBe(second);
        expect(second.get(ParentService).items).toEqual([
          'itemA',
          'itemB',
        ]);
      });

      it('should bind global providers into a rescanned dynamic import', async () => {
        // Arrange
        const definition: DynamicModule = {
          module: GlobalHuskRootModule,
          imports: [{ module: ChildNeedsGlobalModule }],
        };

        // Act
        const moduleRef = await lazyModuleLoader.load(() => definition);

        // Assert
        expect(moduleRef.get(GlobalHuskConsumer).childOut).toBe(
          'child(globalDep)',
        );
      });
    });

    describe('lifecycle hooks after application initialization', () => {
      let events: string[];
      let loggerErrorSpy: ReturnType<typeof vitest.spyOn>;

      @Injectable()
      class DeepService {
        onModuleInit() {
          events.push('deep:init');
        }
        onApplicationBootstrap() {
          events.push('deep:boot');
        }
        onModuleDestroy() {
          events.push('deep:destroy');
        }
        beforeApplicationShutdown() {
          events.push('deep:before');
        }
        onApplicationShutdown() {
          events.push('deep:shutdown');
        }
      }

      @Module({ providers: [DeepService], exports: [DeepService] })
      class DeepModule {}

      @Injectable()
      class ChildBService {
        onModuleInit() {
          events.push('b:init');
        }
        onApplicationBootstrap() {
          events.push('b:boot');
        }
        onModuleDestroy() {
          events.push('b:destroy');
        }
        beforeApplicationShutdown() {
          events.push('b:before');
        }
        onApplicationShutdown() {
          events.push('b:shutdown');
        }
      }

      @Module({
        imports: [DeepModule],
        providers: [ChildBService],
        exports: [ChildBService],
      })
      class ChildBModule {}

      @Injectable()
      class ChildCService {
        onModuleInit() {
          events.push('c:init');
        }
        onApplicationBootstrap() {
          events.push('c:boot');
        }
        onModuleDestroy() {
          events.push('c:destroy');
        }
        beforeApplicationShutdown() {
          events.push('c:before');
        }
        onApplicationShutdown() {
          events.push('c:shutdown');
        }
      }

      @Module({ providers: [ChildCService], exports: [ChildCService] })
      class ChildCModule {}

      @Injectable()
      class RootService {
        onModuleInit() {
          events.push('root:init');
        }
        onApplicationBootstrap() {
          events.push('root:boot');
        }
        onModuleDestroy() {
          events.push('root:destroy');
        }
        beforeApplicationShutdown() {
          events.push('root:before');
        }
        onApplicationShutdown() {
          events.push('root:shutdown');
        }
      }

      @Module({
        imports: [ChildBModule, ChildCModule],
        providers: [RootService],
      })
      class LazyRootModule {}

      beforeEach(async () => {
        events = [];
        loggerErrorSpy = vitest
          .spyOn(Logger, 'error')
          .mockImplementation(() => undefined);

        @Module({})
        class EagerRootModule {}

        await dependenciesScanner.scan(EagerRootModule);
        await instanceLoader.createInstancesOfDependencies();
        await lazyModuleLoader.markApplicationInitialized();
      });

      afterEach(() => {
        loggerErrorSpy.mockRestore();
      });

      it('runs onModuleInit importees-first, then onApplicationBootstrap in the same order', async () => {
        await lazyModuleLoader.load(() => LazyRootModule);

        expect(events).toEqual([
          'deep:init',
          'b:init',
          'c:init',
          'root:init',
          'deep:boot',
          'b:boot',
          'c:boot',
          'root:boot',
        ]);
      });

      it('does not re-run hooks on repeated loads', async () => {
        await lazyModuleLoader.load(() => LazyRootModule);
        await lazyModuleLoader.load(() => LazyRootModule);
        await lazyModuleLoader.load(() => ({
          module: LazyRootModule,
          providers: [{ provide: 'EXTRA', useValue: 1 }],
        }));

        expect(events.filter(e => e.endsWith(':init'))).toEqual([
          'deep:init',
          'b:init',
          'c:init',
          'root:init',
        ]);
        expect(events.filter(e => e.endsWith(':boot'))).toEqual([
          'deep:boot',
          'b:boot',
          'c:boot',
          'root:boot',
        ]);
      });

      it('initializes concurrently loaded identical modules only once', async () => {
        const [first, second] = await Promise.all([
          lazyModuleLoader.load(() => LazyRootModule),
          lazyModuleLoader.load(() => LazyRootModule),
        ]);

        expect(first).toBe(second);
        expect(events.filter(e => e.endsWith(':init'))).toHaveLength(4);
      });

      it('rejects every concurrent load with the original hook error', async () => {
        const boomError = new Error('boom-init');

        @Injectable()
        class FlakyInitService {
          onModuleInit() {
            events.push('flaky:init');
            throw boomError;
          }
        }

        @Module({ providers: [FlakyInitService] })
        class FlakyModule {}

        @Module({ imports: [FlakyModule] })
        class FirstRootModule {}

        @Module({ imports: [FlakyModule] })
        class SecondRootModule {}

        const results = await Promise.allSettled([
          lazyModuleLoader.load(() => FirstRootModule),
          lazyModuleLoader.load(() => SecondRootModule),
        ]);

        expect(results[0].status).toBe('rejected');
        expect(results[1].status).toBe('rejected');
        expect((results[0] as PromiseRejectedResult).reason).toBe(boomError);
        expect((results[1] as PromiseRejectedResult).reason).toBe(boomError);
      });

      it('retries only missing hooks, keeping successfully run hooks untouched', async () => {
        const boomError = new Error('boom-init-retry');
        let shouldFail = true;

        @Injectable()
        class GoodInitService {
          onModuleInit() {
            events.push('good:init');
          }
          onApplicationBootstrap() {
            events.push('good:boot');
          }
        }

        @Module({
          providers: [GoodInitService],
          exports: [GoodInitService],
        })
        class GoodModule {}

        @Injectable()
        class FlakyInitService {
          onModuleInit() {
            if (shouldFail) {
              throw boomError;
            }
            events.push('flaky:init');
          }
          onApplicationBootstrap() {
            events.push('flaky:boot');
          }
        }

        @Module({ providers: [FlakyInitService] })
        class FlakyModule {}

        @Module({ imports: [GoodModule, FlakyModule] })
        class RetryableRootModule {}

        await expect(
          lazyModuleLoader.load(() => RetryableRootModule),
        ).rejects.toBe(boomError);

        // `good:init` ran before the failure; bootstrap never started.
        expect(events).toEqual(['good:init']);

        shouldFail = false;
        const moduleRef = await lazyModuleLoader.load(
          () => RetryableRootModule,
        );
        expect(moduleRef).toBeInstanceOf(ModuleRef);

        expect(events).toEqual([
          'good:init',
          'flaky:init',
          'good:boot',
          'flaky:boot',
        ]);
      });

      it('retries a failed onApplicationBootstrap without re-running onModuleInit', async () => {
        const boomError = new Error('boom-bootstrap');
        let shouldFail = true;

        @Injectable()
        class FlakyBootstrapService {
          onModuleInit() {
            events.push('flaky:init');
          }
          onApplicationBootstrap() {
            if (shouldFail) {
              throw boomError;
            }
            events.push('flaky:boot');
          }
        }

        @Module({ providers: [FlakyBootstrapService] })
        class FlakyBootstrapModule {}

        await expect(
          lazyModuleLoader.load(() => FlakyBootstrapModule),
        ).rejects.toBe(boomError);
        expect(events).toEqual(['flaky:init']);

        shouldFail = false;
        await lazyModuleLoader.load(() => FlakyBootstrapModule);

        expect(events).toEqual(['flaky:init', 'flaky:boot']);
      });

      it('runs shutdown hooks in reverse startup order, once per instance', async () => {
        await lazyModuleLoader.load(() => LazyRootModule);
        events = [];

        await lazyModuleLoader.close();

        expect(events).toEqual([
          // onModuleDestroy phase, reverse startup order
          'root:destroy',
          'c:destroy',
          'b:destroy',
          'deep:destroy',
          // beforeApplicationShutdown phase
          'root:before',
          'c:before',
          'b:before',
          'deep:before',
          // onApplicationShutdown phase
          'root:shutdown',
          'c:shutdown',
          'b:shutdown',
          'deep:shutdown',
        ]);

        events = [];
        await Promise.all([
          lazyModuleLoader.close(),
          lazyModuleLoader.close(),
        ]);
        await lazyModuleLoader.close();
        expect(events).toEqual([]);
      });

      it('keeps the shutdown sequence going when shutdown hooks throw and still resolves', async () => {
        @Injectable()
        class ExplodingShutdownService {
          onModuleDestroy() {
            events.push('exploding:destroy');
            throw new Error('boom-destroy');
          }
          beforeApplicationShutdown() {
            events.push('exploding:before');
            throw new Error('boom-before');
          }
          onApplicationShutdown() {
            events.push('exploding:shutdown');
            throw new Error('boom-shutdown');
          }
        }

        @Module({
          imports: [ChildBModule, ChildCModule],
          providers: [ExplodingShutdownService, RootService],
        })
        class ExplodingRootModule {}

        await lazyModuleLoader.load(() => ExplodingRootModule);
        events = [];

        await expect(lazyModuleLoader.close()).resolves.toBeUndefined();

        // Every instance was still visited, in every phase.
        expect(events).toContain('exploding:destroy');
        expect(events).toContain('exploding:before');
        expect(events).toContain('exploding:shutdown');
        expect(events).toContain('deep:shutdown');
        expect(events).toContain('root:shutdown');
      });

      it('rejects loads after close with "Application is closed" without instantiating anything', async () => {
        await lazyModuleLoader.load(() => LazyRootModule);
        await lazyModuleLoader.close();

        let constructions = 0;
        @Injectable()
        class NeverConstructedService {
          constructor() {
            constructions++;
          }
        }
        @Module({ providers: [NeverConstructedService] })
        class NeverLoadedModule {}

        await expect(
          lazyModuleLoader.load(() => NeverLoadedModule),
        ).rejects.toThrow('Application is closed');
        expect(constructions).toBe(0);
      });
    });

    describe('loaded before application initialization', () => {
      it('lets the application init sweep run the hooks and never re-runs them', async () => {
        const events: string[] = [];

        @Injectable()
        class PreInitService {
          onModuleInit() {
            events.push('preinit:init');
          }
          onApplicationBootstrap() {
            events.push('preinit:boot');
          }
          onModuleDestroy() {
            events.push('preinit:destroy');
          }
        }

        @Module({ providers: [PreInitService] })
        class PreInitLazyModule {}

        @Module({})
        class EagerRootModule {}

        await dependenciesScanner.scan(EagerRootModule);
        await instanceLoader.createInstancesOfDependencies();

        // Load before the application initialized: hooks must not run yet.
        await lazyModuleLoader.load(() => PreInitLazyModule);
        expect(events).toEqual([]);

        // Simulate the application init sweep over every registered module.
        const allModules = [...modulesContainer.values()];
        for (const moduleRef of allModules) {
          await callModuleInitHook(moduleRef);
        }
        for (const moduleRef of allModules) {
          await callModuleBootstrapHook(moduleRef);
        }
        await lazyModuleLoader.markApplicationInitialized(allModules);

        expect(events).toEqual(['preinit:init', 'preinit:boot']);

        // A repeated load must not trigger the hooks again.
        await lazyModuleLoader.load(() => PreInitLazyModule);
        expect(events).toEqual(['preinit:init', 'preinit:boot']);
      });
    });
  });
});

describe('LazyModuleLoader (application integration)', () => {
  const events: string[] = [];

  @Injectable()
  class LazyService {
    onModuleInit() {
      events.push('lazy:init');
    }
    onApplicationBootstrap() {
      events.push('lazy:boot');
    }
    onModuleDestroy() {
      events.push('lazy:destroy');
    }
    beforeApplicationShutdown() {
      events.push('lazy:before');
    }
    onApplicationShutdown() {
      events.push('lazy:shutdown');
    }
  }

  @Module({ providers: [LazyService], exports: [LazyService] })
  class LazyFeatureModule {}

  @Injectable()
  class EagerService {
    onModuleInit() {
      events.push('eager:init');
    }
    onApplicationBootstrap() {
      events.push('eager:boot');
    }
    onModuleDestroy() {
      events.push('eager:destroy');
    }
    beforeApplicationShutdown() {
      events.push('eager:before');
    }
    onApplicationShutdown() {
      events.push('eager:shutdown');
    }
  }

  @Module({ providers: [EagerService] })
  class ApplicationModule {}

  let loggerErrorSpy: ReturnType<typeof vitest.spyOn>;

  beforeEach(() => {
    events.length = 0;
    loggerErrorSpy = vitest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('runs lazy lifecycle hooks after init and shuts them down on close', async () => {
    const app = await NestFactory.createApplicationContext(ApplicationModule, {
      logger: false,
    });
    expect(events).toEqual(['eager:init', 'eager:boot']);

    const lazyModuleLoader = app.get(LazyModuleLoader);
    const moduleRef = await lazyModuleLoader.load(() => LazyFeatureModule);
    expect(moduleRef.get(LazyService)).toBeInstanceOf(LazyService);
    expect(events).toEqual([
      'eager:init',
      'eager:boot',
      'lazy:init',
      'lazy:boot',
    ]);

    await app.close();
    expect(events).toEqual([
      'eager:init',
      'eager:boot',
      'lazy:init',
      'lazy:boot',
      // Lazily loaded modules shut down first, in reverse startup order.
      'lazy:destroy',
      'eager:destroy',
      'lazy:before',
      'eager:before',
      'lazy:shutdown',
      'eager:shutdown',
    ]);

    // The application is closed: further loads are rejected.
    await expect(lazyModuleLoader.load(() => LazyFeatureModule)).rejects.toThrow(
      'Application is closed',
    );

    // A second close does not re-run any lazy hook.
    await app.close();
    expect(events.filter(e => e === 'lazy:destroy')).toHaveLength(1);
    expect(events.filter(e => e === 'lazy:before')).toHaveLength(1);
    expect(events.filter(e => e === 'lazy:shutdown')).toHaveLength(1);
  });
});


