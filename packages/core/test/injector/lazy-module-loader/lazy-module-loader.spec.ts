import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import {
  LazyModuleLoader,
  ModuleRef,
  ModulesContainer,
  NestContainer,
} from '../../../injector/index.js';
import { Injector } from '../../../injector/injector.js';
import { InstanceLoader } from '../../../injector/instance-loader.js';
import { GraphInspector } from '../../../inspector/graph-inspector.js';
import { MetadataScanner } from '../../../metadata-scanner.js';
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
        expect(moduleRef.get(ParentService).items).toEqual(['itemA', 'itemB']);
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
        expect(second.get(ParentService).items).toEqual(['itemA', 'itemB']);
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
  });

  describe('lifecycle hooks', () => {
    it('should run onModuleInit and onApplicationBootstrap, imported modules first and same-parent imports in order', async () => {
      const calls: string[] = [];

      @Injectable()
      class ServiceB1 {
        onModuleInit() {
          calls.push('B1.provider.init');
        }
        onApplicationBootstrap() {
          calls.push('B1.provider.bootstrap');
        }
      }
      @Module({ providers: [ServiceB1] })
      class ModuleB1 {
        onModuleInit() {
          calls.push('B1.module.init');
        }
        onApplicationBootstrap() {
          calls.push('B1.module.bootstrap');
        }
      }

      @Injectable()
      class ServiceB2 {
        onModuleInit() {
          calls.push('B2.provider.init');
        }
        onApplicationBootstrap() {
          calls.push('B2.provider.bootstrap');
        }
      }
      @Module({ providers: [ServiceB2] })
      class ModuleB2 {
        onModuleInit() {
          calls.push('B2.module.init');
        }
        onApplicationBootstrap() {
          calls.push('B2.module.bootstrap');
        }
      }

      @Injectable()
      class ServiceA {
        onModuleInit() {
          calls.push('A.provider.init');
        }
        onApplicationBootstrap() {
          calls.push('A.provider.bootstrap');
        }
      }
      @Module({ imports: [ModuleB1, ModuleB2], providers: [ServiceA] })
      class ModuleA {
        onModuleInit() {
          calls.push('A.module.init');
        }
        onApplicationBootstrap() {
          calls.push('A.module.bootstrap');
        }
      }

      await lazyModuleLoader.load(() => ModuleA);

      expect(calls).toEqual([
        'B1.provider.init',
        'B1.module.init',
        'B2.provider.init',
        'B2.module.init',
        'A.provider.init',
        'A.module.init',
        'B1.provider.bootstrap',
        'B1.module.bootstrap',
        'B2.provider.bootstrap',
        'B2.module.bootstrap',
        'A.provider.bootstrap',
        'A.module.bootstrap',
      ]);
    });

    it('should not re-run hooks on repeated load and should return the same module reference', async () => {
      let initCount = 0;
      let bootstrapCount = 0;

      @Injectable()
      class HookedService {
        onModuleInit() {
          initCount++;
        }
        onApplicationBootstrap() {
          bootstrapCount++;
        }
      }
      @Module({ providers: [HookedService] })
      class HookedModule {}

      const moduleRef = await lazyModuleLoader.load(() => HookedModule);
      const moduleRef2 = await lazyModuleLoader.load(() => HookedModule);

      expect(moduleRef).toBe(moduleRef2);
      expect(initCount).toBe(1);
      expect(bootstrapCount).toBe(1);
    });

    it('should initialize the module only once for concurrent load calls', async () => {
      let constructionsCount = 0;
      let initCount = 0;

      @Injectable()
      class HookedService {
        constructor() {
          constructionsCount++;
        }
        onModuleInit() {
          initCount++;
        }
      }
      @Module({ providers: [HookedService] })
      class HookedModule {}

      const [moduleRef, moduleRef2] = await Promise.all([
        lazyModuleLoader.load(() => HookedModule),
        lazyModuleLoader.load(() => HookedModule),
      ]);

      expect(moduleRef).toBe(moduleRef2);
      expect(constructionsCount).toBe(1);
      expect(initCount).toBe(1);
    });

    it('should use the module class as identity, ignoring dynamic metadata', async () => {
      let constructionsCount = 0;
      let initCount = 0;

      @Injectable()
      class HookedService {
        constructor() {
          constructionsCount++;
        }
        onModuleInit() {
          initCount++;
        }
      }
      @Module({})
      class DynamicIdentityModule {}

      const moduleRef = await lazyModuleLoader.load((): DynamicModule => ({
        module: DynamicIdentityModule,
        providers: [HookedService],
      }));
      const moduleRef2 = await lazyModuleLoader.load((): DynamicModule => ({
        module: DynamicIdentityModule,
        providers: [{ provide: 'IGNORED', useValue: 'ignored' }],
      }));

      expect(moduleRef).toBe(moduleRef2);
      expect(moduleRef.get(HookedService)).toBeInstanceOf(HookedService);
      expect(constructionsCount).toBe(1);
      expect(initCount).toBe(1);
    });

    it('should not run hooks for modules that were already instantiated', async () => {
      let sharedInitCount = 0;
      let lazyInitCount = 0;

      @Injectable()
      class SharedService {
        onModuleInit() {
          sharedInitCount++;
        }
      }
      @Module({ providers: [SharedService], exports: [SharedService] })
      class AlreadyLoadedModule {}

      @Injectable()
      class LazyService {
        onModuleInit() {
          lazyInitCount++;
        }
      }
      @Module({ imports: [AlreadyLoadedModule], providers: [LazyService] })
      class LazyRootModule {}

      // Boot the shared module eagerly (as the application would)
      await dependenciesScanner.scan(AlreadyLoadedModule);
      await instanceLoader.createInstancesOfDependencies();

      await lazyModuleLoader.load(() => LazyRootModule);

      expect(sharedInitCount).toBe(0);
      expect(lazyInitCount).toBe(1);
    });

    describe('when a startup hook fails', () => {
      it('should reject with the original error and only complete pending instances on retry', async () => {
        const calls: string[] = [];
        const failure = new Error('onModuleInit failed');
        let shouldFail = true;

        @Injectable()
        class ServiceB {
          onModuleInit() {
            calls.push('B.init');
          }
          onApplicationBootstrap() {
            calls.push('B.bootstrap');
          }
        }
        @Module({ providers: [ServiceB] })
        class ModuleB {}

        @Injectable()
        class ServiceA {
          onModuleInit() {
            if (shouldFail) {
              throw failure;
            }
            calls.push('A.init');
          }
          onApplicationBootstrap() {
            calls.push('A.bootstrap');
          }
        }
        @Module({ imports: [ModuleB], providers: [ServiceA] })
        class ModuleA {}

        await expect(lazyModuleLoader.load(() => ModuleA)).rejects.toBe(
          failure,
        );
        expect(calls).toEqual(['B.init']);

        shouldFail = false;
        const moduleRef = await lazyModuleLoader.load(() => ModuleA);

        expect(moduleRef).toBeInstanceOf(ModuleRef);
        expect(calls).toEqual([
          'B.init',
          'A.init',
          'B.bootstrap',
          'A.bootstrap',
        ]);
      });

      it('should not re-run completed phases when a later phase fails', async () => {
        const calls: string[] = [];
        const failure = new Error('onApplicationBootstrap failed');
        let shouldFail = true;

        @Injectable()
        class HookedService {
          onModuleInit() {
            calls.push('init');
          }
          onApplicationBootstrap() {
            if (shouldFail) {
              throw failure;
            }
            calls.push('bootstrap');
          }
        }
        @Module({ providers: [HookedService] })
        class HookedModule {}

        await expect(lazyModuleLoader.load(() => HookedModule)).rejects.toBe(
          failure,
        );
        expect(calls).toEqual(['init']);

        shouldFail = false;
        await lazyModuleLoader.load(() => HookedModule);
        expect(calls).toEqual(['init', 'bootstrap']);
      });
    });
  });

  describe('close', () => {
    it('should run shutdown hooks in reverse startup order, once per instance', async () => {
      const calls: string[] = [];

      @Injectable()
      class ServiceB {
        onModuleDestroy() {
          calls.push('B.destroy');
        }
        beforeApplicationShutdown() {
          calls.push('B.beforeShutdown');
        }
        onApplicationShutdown() {
          calls.push('B.shutdown');
        }
      }
      @Module({ providers: [ServiceB] })
      class ModuleB {}

      @Injectable()
      class ServiceA {
        onModuleDestroy() {
          calls.push('A.destroy');
        }
        beforeApplicationShutdown() {
          calls.push('A.beforeShutdown');
        }
        onApplicationShutdown() {
          calls.push('A.shutdown');
        }
      }
      @Module({ imports: [ModuleB], providers: [ServiceA] })
      class ModuleA {}

      await lazyModuleLoader.load(() => ModuleA);
      await lazyModuleLoader.close();

      expect(calls).toEqual([
        'A.destroy',
        'B.destroy',
        'A.beforeShutdown',
        'B.beforeShutdown',
        'A.shutdown',
        'B.shutdown',
      ]);
    });

    it('should destroy modules from separate loads in reverse load order', async () => {
      const calls: string[] = [];

      @Injectable()
      class Service1 {
        onModuleDestroy() {
          calls.push('1.destroy');
        }
      }
      @Module({ providers: [Service1] })
      class Module1 {}

      @Injectable()
      class Service2 {
        onModuleDestroy() {
          calls.push('2.destroy');
        }
      }
      @Module({ providers: [Service2] })
      class Module2 {}

      await lazyModuleLoader.load(() => Module1);
      await lazyModuleLoader.load(() => Module2);
      await lazyModuleLoader.close();

      expect(calls).toEqual(['2.destroy', '1.destroy']);
    });

    it('should not destroy instances again on concurrent or repeated close calls', async () => {
      let destroyCount = 0;

      @Injectable()
      class HookedService {
        onModuleDestroy() {
          destroyCount++;
        }
      }
      @Module({ providers: [HookedService] })
      class HookedModule {}

      await lazyModuleLoader.load(() => HookedModule);
      await Promise.all([lazyModuleLoader.close(), lazyModuleLoader.close()]);
      await lazyModuleLoader.close();

      expect(destroyCount).toBe(1);
    });

    it('should reject load calls after close without creating instances', async () => {
      let constructionsCount = 0;
      let loaderCalled = false;

      @Injectable()
      class SomeService {
        constructor() {
          constructionsCount++;
        }
      }
      @Module({ providers: [SomeService] })
      class SomeModule {}

      await lazyModuleLoader.close();

      await expect(
        lazyModuleLoader.load(() => {
          loaderCalled = true;
          return SomeModule;
        }),
      ).rejects.toThrow('Application is closed');
      expect(loaderCalled).toBe(false);
      expect(constructionsCount).toBe(0);
    });

    it('should resolve close even when shutdown hooks throw', async () => {
      const calls: string[] = [];

      @Injectable()
      class FailingService {
        onModuleDestroy() {
          throw new Error('destroy failed');
        }
        beforeApplicationShutdown() {
          throw new Error('beforeApplicationShutdown failed');
        }
      }
      @Injectable()
      class OtherService {
        onModuleDestroy() {
          calls.push('other.destroy');
        }
        onApplicationShutdown() {
          calls.push('other.shutdown');
        }
      }
      @Module({ providers: [FailingService, OtherService] })
      class SomeModule {}

      await lazyModuleLoader.load(() => SomeModule);

      await expect(lazyModuleLoader.close()).resolves.toBeUndefined();
      expect(calls).toEqual(['other.destroy', 'other.shutdown']);
    });
  });
});
