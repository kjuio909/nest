import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { isFunction, isNil } from '@nestjs/common/internal';
import { iterate } from 'iterare';
import { Module } from '../injector/module.js';
import { getInstancesGroupedByHierarchyLevel } from './utils/get-instances-grouped-by-hierarchy-level.js';
import { getSortedHierarchyLevels } from './utils/get-sorted-hierarchy-levels.js';

/**
 * Returns true or false if the given instance has a `onModuleDestroy` function
 *
 * @param instance The instance which should be checked
 */
function hasOnModuleDestroyHook(
  instance: unknown,
): instance is OnModuleDestroy {
  return isFunction((instance as OnModuleDestroy).onModuleDestroy);
}

/**
 * Calls the given instances onModuleDestroy hook
 */
function callOperator(
  instances: unknown[],
  calledInstances?: WeakSet<object>,
): Promise<any>[] {
  return iterate(instances)
    .filter(instance => !isNil(instance))
    .filter(hasOnModuleDestroyHook)
    .filter(instance => !calledInstances?.has(instance as object))
    .map(async instance => {
      // Destroy hooks run at most once per instance, even when they fail.
      calledInstances?.add(instance as object);
      return (instance as any as OnModuleDestroy).onModuleDestroy();
    })
    .toArray();
}

/**
 * Calls the `onModuleDestroy` function on the module and its children
 * (providers / controllers).
 *
 * @param moduleRef The module which will be initialized
 * @param calledInstances Optional set of instances whose hook has already
 * been triggered. Instances in the set are skipped; every triggered
 * instance is added to the set exactly once.
 */
export async function callModuleDestroyHook(
  moduleRef: Module,
  calledInstances?: WeakSet<object>,
): Promise<any> {
  const providers = moduleRef.getNonAliasProviders();
  // Module (class) instance is the first element of the providers array
  // Lifecycle hook has to be called once all classes are properly destroyed
  const [_, moduleClassHost] = providers.shift()!;
  const groupedInstances = getInstancesGroupedByHierarchyLevel(
    moduleRef.controllers,
    moduleRef.injectables,
    moduleRef.middlewares,
    providers,
  );

  const levels = getSortedHierarchyLevels(groupedInstances, 'DESC');
  for (const level of levels) {
    const results = await Promise.allSettled(
      callOperator(groupedInstances.get(level)!, calledInstances),
    );
    results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .forEach(result =>
        Logger.error(result.reason, (result.reason as Error)?.stack),
      );
  }

  // Call the module instance itself
  const moduleClassInstance = moduleClassHost.instance;
  if (
    moduleClassInstance &&
    hasOnModuleDestroyHook(moduleClassInstance) &&
    moduleClassHost.isDependencyTreeStatic() &&
    !calledInstances?.has(moduleClassInstance)
  ) {
    calledInstances?.add(moduleClassInstance);
    try {
      await moduleClassInstance.onModuleDestroy();
    } catch (err) {
      Logger.error(err, (err as Error)?.stack);
    }
  }
}
