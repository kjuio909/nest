import type { DynamicModule, Type } from '@nestjs/common';
import {
  callAppShutdownHook,
  callBeforeAppShutdownHook,
  callModuleBootstrapHook,
  callModuleDestroyHook,
  callModuleInitHook,
} from '../../hooks/index.js';
import { ModuleOverride } from '../../interfaces/module-override.interface.js';
import { DependenciesScanner } from '../../scanner.js';
import { ModuleCompiler } from '../compiler.js';
import { SilentLogger } from '../helpers/silent-logger.js';
import { InstanceLoader } from '../instance-loader.js';
import { Module } from '../module.js';
import { ModuleRef } from '../module-ref.js';
import { ModulesContainer } from '../modules-container.js';
import { LazyModuleLoaderLoadOptions } from './lazy-module-loader-options.interface.js';

export class LazyModuleLoader {
  /**
   * Modules instantiated by this loader, in load (registration) order.
   * Modules that are part of the eager graph are never tracked here: the
   * `NestApplicationContext` owns their lifecycle instead.
   */
  private lazyModules: Module[] = [];

  /**
   * Roots that have been fully resolved through this loader, keyed by their
   * identity - the module class. Dynamic metadata does not contribute to the
   * identity, so repeated loads of the same class always return the very
   * same `ModuleRef`.
   */
  private readonly resolvedRoots = new Map<Type<unknown>, ModuleRef>();

  /**
   * Loads currently in flight, keyed by the root module class. Concurrent
   * loads of the same class coalesce onto the same promise.
   */
  private readonly loadsInFlight = new Map<Type<unknown>, Promise<ModuleRef>>();

  /**
   * Instances whose lifecycle hooks have already been triggered by this
   * loader, tracked per hook. Guarantees that every hook runs at most once
   * per instance, no matter how often a module is loaded or closed.
   */
  private readonly onModuleInitCalled = new WeakSet<object>();
  private readonly onAppBootstrapCalled = new WeakSet<object>();
  private readonly onModuleDestroyCalled = new WeakSet<object>();
  private readonly beforeAppShutdownCalled = new WeakSet<object>();
  private readonly onAppShutdownCalled = new WeakSet<object>();

  /**
   * `false` until the host application has finished its own `init()` cycle.
   * Loads happening before that point only instantiate providers - the
   * application init sweep runs the lifecycle hooks for them.
   */
  private applicationInitialized = false;
  private isClosed = false;
  private closePromise?: Promise<void>;

  /**
   * Serializes the critical sections of `load()` and `close()` (scanning,
   * instantiation and lifecycle hooks) so concurrent loads can never
   * initialize the same module twice or interleave hook execution.
   */
  private lifecycleQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dependenciesScanner: DependenciesScanner,
    private readonly instanceLoader: InstanceLoader,
    private readonly moduleCompiler: ModuleCompiler,
    private readonly modulesContainer: ModulesContainer,
    private readonly moduleOverrides?: ModuleOverride[],
  ) {}

  public async load(
    loaderFn: () =>
      Promise<Type<unknown> | DynamicModule> | Type<unknown> | DynamicModule,
    loadOpts?: LazyModuleLoaderLoadOptions,
  ): Promise<ModuleRef> {
    if (this.isClosed) {
      throw new Error('Application is closed');
    }

    const originalLogger = (this.instanceLoader as any).logger;
    try {
      this.registerLoggerConfiguration(loadOpts);

      const moduleClassOrDynamicDefinition = await loaderFn();
      const { type: rootType } = this.moduleCompiler.extractMetadata(
        moduleClassOrDynamicDefinition,
      );

      const inFlightLoad = this.loadsInFlight.get(rootType);
      if (inFlightLoad) {
        return inFlightLoad;
      }
      const resolvedRoot = this.resolvedRoots.get(rootType);
      if (resolvedRoot) {
        return resolvedRoot;
      }

      const loadPromise = this.enqueue(() =>
        this.loadModule(moduleClassOrDynamicDefinition),
      );
      this.loadsInFlight.set(rootType, loadPromise);
      try {
        const moduleRef = await loadPromise;
        this.resolvedRoots.set(rootType, moduleRef);
        return moduleRef;
      } finally {
        this.loadsInFlight.delete(rootType);
      }
    } finally {
      if (loadOpts?.logger === false) {
        this.instanceLoader.setLogger(originalLogger);
      }
    }
  }

  /**
   * Notifies the loader that the host application has completed its own
   * `onModuleInit` / `onApplicationBootstrap` sweep. Every subsequently
   * loaded module runs its lifecycle hooks as part of `load()` itself.
   *
   * Modules instantiated before this point are handed over to the
   * application context: the modules swept during its init cycle (and
   * later during its shutdown) are removed from the loader's registry, so
   * their hooks are never triggered twice.
   */
  public async markApplicationInitialized(
    sweptModules: Module[] = [],
  ): Promise<void> {
    this.applicationInitialized = true;
    if (sweptModules.length > 0) {
      const swept = new Set(sweptModules);
      this.lazyModules = this.lazyModules.filter(
        moduleRef => !swept.has(moduleRef),
      );
    }
    await this.enqueue(async () => {
      await this.callInitHooks();
      await this.callBootstrapHooks();
    });
  }

  /**
   * Runs the full shutdown sequence (`onModuleDestroy`,
   * `beforeApplicationShutdown`, `onApplicationShutdown`) on the lazily
   * loaded modules, in reverse startup order. Concurrent and repeated
   * calls are no-ops awaiting the very same promise.
   */
  public close(signal?: string): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.isClosed = true;
    this.closePromise = this.enqueue(async () => {
      await this.runOnModuleDestroyHooks();
      await this.runBeforeApplicationShutdownHooks(signal);
      await this.runOnApplicationShutdownHooks(signal);
    });
    return this.closePromise;
  }

  /**
   * Runs the `onModuleDestroy` hook on lazily loaded modules, in reverse
   * startup order. Idempotent: every instance is triggered at most once.
   */
  public callOnModuleDestroyHooks(): Promise<void> {
    this.isClosed = true;
    return this.enqueue(() => this.runOnModuleDestroyHooks());
  }

  /**
   * Runs the `beforeApplicationShutdown` hook on lazily loaded modules, in
   * reverse startup order. Idempotent.
   */
  public callBeforeApplicationShutdownHooks(signal?: string): Promise<void> {
    this.isClosed = true;
    return this.enqueue(() => this.runBeforeApplicationShutdownHooks(signal));
  }

  /**
   * Runs the `onApplicationShutdown` hook on lazily loaded modules, in
   * reverse startup order. Idempotent.
   */
  public callOnApplicationShutdownHooks(signal?: string): Promise<void> {
    this.isClosed = true;
    return this.enqueue(() => this.runOnApplicationShutdownHooks(signal));
  }

  private async runOnModuleDestroyHooks(): Promise<void> {
    for (const moduleRef of this.getModulesInShutdownOrder()) {
      await callModuleDestroyHook(moduleRef, this.onModuleDestroyCalled);
    }
  }

  private async runBeforeApplicationShutdownHooks(
    signal?: string,
  ): Promise<void> {
    for (const moduleRef of this.getModulesInShutdownOrder()) {
      await callBeforeAppShutdownHook(
        moduleRef,
        signal,
        this.beforeAppShutdownCalled,
      );
    }
  }

  private async runOnApplicationShutdownHooks(signal?: string): Promise<void> {
    for (const moduleRef of this.getModulesInShutdownOrder()) {
      await callAppShutdownHook(moduleRef, signal, this.onAppShutdownCalled);
    }
  }

  private async loadModule(
    moduleClassOrDynamicDefinition: Type<unknown> | DynamicModule,
  ): Promise<ModuleRef> {
    if (this.isClosed) {
      throw new Error('Application is closed');
    }

    const moduleInstances = await this.dependenciesScanner.scanForModules({
      moduleDefinition: moduleClassOrDynamicDefinition,
      overrides: this.moduleOverrides,
      lazy: true,
    });
    if (moduleInstances.length === 0) {
      // The module has been loaded already. In this case, we must
      // retrieve a module reference from the existing container.
      if (this.applicationInitialized) {
        // A previous load may have failed while running the lifecycle
        // hooks. Complete the missing hooks before resolving.
        await this.callInitHooks();
        await this.callBootstrapHooks();
      }
      const { token } = await this.moduleCompiler.compile(
        moduleClassOrDynamicDefinition,
      );
      const moduleInstance = this.modulesContainer.get(token)!;
      return moduleInstance && this.getTargetModuleRef(moduleInstance);
    }

    const lazyModulesContainer =
      this.createLazyModulesContainer(moduleInstances);
    await this.dependenciesScanner.scanModulesForDependencies(
      lazyModulesContainer,
    );
    await this.instanceLoader.createInstancesOfDependencies(
      lazyModulesContainer,
    );

    this.registerLazyModules(moduleInstances);

    if (this.applicationInitialized) {
      await this.callInitHooks();
      await this.callBootstrapHooks();
    }

    const [targetModule] = moduleInstances;
    return this.getTargetModuleRef(targetModule);
  }

  private enqueue<T>(criticalSection: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(criticalSection);
    // Keep the queue alive even when a section fails.
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private registerLoggerConfiguration(loadOpts?: LazyModuleLoaderLoadOptions) {
    if (loadOpts?.logger === false) {
      this.instanceLoader.setLogger(new SilentLogger());
    }
  }

  private createLazyModulesContainer(
    moduleInstances: Module[],
  ): Map<string, Module> {
    moduleInstances = Array.from(new Set(moduleInstances));
    return new Map(moduleInstances.map(ref => [ref.token, ref]));
  }

  private registerLazyModules(moduleInstances: Module[]) {
    for (const moduleRef of new Set(moduleInstances)) {
      if (!this.lazyModules.includes(moduleRef)) {
        this.lazyModules.push(moduleRef);
      }
    }
  }

  /**
   * Runs `onModuleInit` on every lazy module whose instances have not been
   * initialized yet. Importees go first; modules imported by the same
   * parent follow its `imports` declaration order. Instances whose hook
   * already succeeded are skipped, so a retry after a failure only
   * completes what is missing.
   */
  private async callInitHooks(): Promise<void> {
    for (const moduleRef of this.getModulesInStartupOrder()) {
      await callModuleInitHook(moduleRef, this.onModuleInitCalled);
    }
  }

  /**
   * Runs `onApplicationBootstrap` in the same order as `onModuleInit`,
   * skipping instances that have already been bootstrapped.
   */
  private async callBootstrapHooks(): Promise<void> {
    for (const moduleRef of this.getModulesInStartupOrder()) {
      await callModuleBootstrapHook(moduleRef, this.onAppBootstrapCalled);
    }
  }

  /**
   * Returns the lazy modules ordered importees-first. Ties follow the
   * order in which the modules were registered, which mirrors the parent's
   * `imports` declaration order thanks to the depth-first module scan.
   */
  private getModulesInStartupOrder(): Module[] {
    const managedModules = new Set(this.lazyModules);
    const visitedModules = new Set<Module>();
    const orderedModules: Module[] = [];

    const visit = (moduleRef: Module) => {
      if (visitedModules.has(moduleRef)) {
        return;
      }
      visitedModules.add(moduleRef);
      for (const importedModuleRef of moduleRef.imports) {
        if (managedModules.has(importedModuleRef)) {
          visit(importedModuleRef);
        }
      }
      orderedModules.push(moduleRef);
    };

    this.lazyModules.forEach(visit);
    return orderedModules;
  }

  private getModulesInShutdownOrder(): Module[] {
    return this.getModulesInStartupOrder().reverse();
  }

  private getTargetModuleRef(moduleInstance: Module): ModuleRef {
    const moduleRefInstanceWrapper = moduleInstance.getProviderByKey(ModuleRef);
    return moduleRefInstanceWrapper.instance;
  }
}
