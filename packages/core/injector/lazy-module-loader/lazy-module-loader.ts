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

/**
 * Tracks the lifecycle hook state of a single lazily loaded module instance,
 * so that failed loads can be retried without re-running completed phases.
 */
interface LazyModuleHookRecord {
  module: Module;
  onModuleInit: boolean;
  onApplicationBootstrap: boolean;
}

export class LazyModuleLoader {
  /**
   * In-flight loads keyed by module identity. The identity of a module is
   * its class — either the `Type` itself or the `module` property of a
   * dynamic module definition. Dynamic metadata does not take part in it.
   */
  private readonly inFlightLoads = new Map<Type<unknown>, Promise<ModuleRef>>();
  /**
   * Resolved module references keyed by module identity (see above).
   */
  private readonly moduleRefsByType = new Map<Type<unknown>, ModuleRef>();
  /**
   * Target module instances keyed by module identity, used to retrieve the
   * module reference when a repeated load carries different dynamic metadata.
   */
  private readonly targetModulesByType = new Map<Type<unknown>, Module>();
  /**
   * Lifecycle hook records of every lazily loaded module, in startup order.
   */
  private readonly hookRecords: LazyModuleHookRecord[] = [];
  private readonly hookRecordsByType = new Map<
    Type<unknown>,
    LazyModuleHookRecord[]
  >();
  private readonly modulesWithHookRecords = new Set<Module>();
  /**
   * Serializes startup hook execution so concurrent loads cannot run
   * lifecycle hooks of the same module instance twice. Never rejects.
   */
  private startupHooksChain: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

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
    if (this.closePromise) {
      throw new Error('Application is closed');
    }
    const moduleClassOrDynamicDefinition = await loaderFn();
    const { type } = this.moduleCompiler.extractMetadata(
      moduleClassOrDynamicDefinition,
    );

    const inFlightLoad = this.inFlightLoads.get(type);
    if (inFlightLoad) {
      return inFlightLoad;
    }
    const cachedModuleRef = this.moduleRefsByType.get(type);
    if (cachedModuleRef) {
      return cachedModuleRef;
    }
    const loadPromise = this.doLoad(
      moduleClassOrDynamicDefinition,
      type,
      loadOpts,
    );
    this.inFlightLoads.set(type, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.inFlightLoads.delete(type);
    }
  }

  /**
   * Runs the shutdown lifecycle hooks (`onModuleDestroy`,
   * `beforeApplicationShutdown`, `onApplicationShutdown`) on every lazily
   * loaded module, in reverse startup order. Each hook is called once per
   * instance; repeated or concurrent calls share the same execution.
   */
  public async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.executeClose();
    }
    return this.closePromise;
  }

  private async doLoad(
    moduleClassOrDynamicDefinition: Type<unknown> | DynamicModule,
    type: Type<unknown>,
    loadOpts?: LazyModuleLoaderLoadOptions,
  ): Promise<ModuleRef> {
    const originalLogger = (this.instanceLoader as any).logger;
    try {
      this.registerLoggerConfiguration(loadOpts);

      const moduleInstances = await this.dependenciesScanner.scanForModules({
        moduleDefinition: moduleClassOrDynamicDefinition,
        overrides: this.moduleOverrides,
        lazy: true,
      });
      if (moduleInstances.length === 0) {
        // The module has been loaded already. In this case, complete any
        // pending lifecycle hooks (a previous load may have failed midway)
        // and retrieve a module reference from the existing container.
        await this.scheduleStartupHooks(this.getHookRecords(type));
        const { token } = await this.moduleCompiler.compile(
          moduleClassOrDynamicDefinition,
        );
        const moduleInstance =
          this.modulesContainer.get(token) ??
          this.targetModulesByType.get(type);
        const moduleRef =
          moduleInstance && this.getTargetModuleRef(moduleInstance);
        if (moduleRef) {
          this.moduleRefsByType.set(type, moduleRef);
        }
        return moduleRef!;
      }
      const lazyModulesContainer =
        this.createLazyModulesContainer(moduleInstances);
      await this.dependenciesScanner.scanModulesForDependencies(
        lazyModulesContainer,
      );
      await this.instanceLoader.createInstancesOfDependencies(
        lazyModulesContainer,
      );
      const [targetModule] = moduleInstances;
      this.targetModulesByType.set(type, targetModule);
      const hookRecords = this.registerHookRecords(type, moduleInstances);
      await this.scheduleStartupHooks(hookRecords);
      const moduleRef = this.getTargetModuleRef(targetModule);
      this.moduleRefsByType.set(type, moduleRef);
      return moduleRef;
    } finally {
      if (loadOpts?.logger === false) {
        this.instanceLoader.setLogger(originalLogger);
      }
    }
  }

  private async executeClose(): Promise<void> {
    // Wait for pending startup hooks to settle before tearing down.
    await this.startupHooksChain;
    const recordsInReverseStartupOrder = [...this.hookRecords].reverse();
    for (const record of recordsInReverseStartupOrder) {
      await callModuleDestroyHook(record.module);
    }
    for (const record of recordsInReverseStartupOrder) {
      await callBeforeAppShutdownHook(record.module);
    }
    for (const record of recordsInReverseStartupOrder) {
      await callAppShutdownHook(record.module);
    }
  }

  /**
   * Registers lifecycle hook records for newly created module instances,
   * ordered so that imported modules come before their importers and
   * same-parent imports keep their declaration order.
   */
  private registerHookRecords(
    type: Type<unknown>,
    moduleInstances: Module[],
  ): LazyModuleHookRecord[] {
    const records = this.getHookRecords(type);
    for (const module of this.sortModulesByImports(moduleInstances)) {
      if (this.modulesWithHookRecords.has(module)) {
        continue;
      }
      this.modulesWithHookRecords.add(module);
      const record: LazyModuleHookRecord = {
        module,
        onModuleInit: false,
        onApplicationBootstrap: false,
      };
      records.push(record);
      this.hookRecords.push(record);
    }
    return records;
  }

  private getHookRecords(type: Type<unknown>): LazyModuleHookRecord[] {
    let records = this.hookRecordsByType.get(type);
    if (!records) {
      records = [];
      this.hookRecordsByType.set(type, records);
    }
    return records;
  }

  /**
   * Runs the pending startup hooks of the given records: `onModuleInit` for
   * every record (in startup order), then `onApplicationBootstrap` in the
   * same order. Instances and phases that already succeeded are skipped, so
   * a retry after a failure only completes what is missing. If a hook
   * throws, the returned promise rejects with the original error.
   */
  private scheduleStartupHooks(records: LazyModuleHookRecord[]): Promise<void> {
    const run = this.startupHooksChain.then(() =>
      this.runStartupHooks(records),
    );
    // Keep the chain alive for subsequent loads even when hooks fail.
    this.startupHooksChain = run.catch(() => undefined);
    return run;
  }

  private async runStartupHooks(
    records: LazyModuleHookRecord[],
  ): Promise<void> {
    for (const record of records) {
      if (!record.onModuleInit) {
        await callModuleInitHook(record.module);
        record.onModuleInit = true;
      }
    }
    for (const record of records) {
      if (!record.onApplicationBootstrap) {
        await callModuleBootstrapHook(record.module);
        record.onApplicationBootstrap = true;
      }
    }
  }

  private sortModulesByImports(modules: Module[]): Module[] {
    const moduleSet = new Set(modules);
    const visited = new Set<Module>();
    const sorted: Module[] = [];
    const visit = (module: Module) => {
      if (visited.has(module) || !moduleSet.has(module)) {
        return;
      }
      visited.add(module);
      for (const importedModule of module.imports) {
        visit(importedModule);
      }
      sorted.push(module);
    };
    modules.forEach(visit);
    return sorted;
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

  private getTargetModuleRef(moduleInstance: Module): ModuleRef {
    const moduleRefInstanceWrapper = moduleInstance.getProviderByKey(ModuleRef);
    return moduleRefInstanceWrapper.instance;
  }
}
