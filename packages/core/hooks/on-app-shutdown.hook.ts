import { Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { isFunction, isNil } from '@nestjs/common/internal';
import { iterate } from 'iterare';
import { Module } from '../injector/module.js';
import { getInstancesGroupedByHierarchyLevel } from './utils/get-instances-grouped-by-hierarchy-level.js';
import { getSortedHierarchyLevels } from './utils/get-sorted-hierarchy-levels.js';

/**
 * Checks if the given instance has the `onApplicationShutdown` function
 *
 * @param instance The instance which should be checked
 */
function hasOnAppShutdownHook(
  instance: unknown,
): instance is OnApplicationShutdown {
  return isFunction((instance as OnApplicationShutdown).onApplicationShutdown);
}

/**
 * Calls the given instances
 */
function callOperator(
  instances: unknown[],
  signal?: string,
  calledInstances?: WeakSet<object>,
): Promise<any>[] {
  return iterate(instances)
    .filter(instance => !isNil(instance))
    .filter(hasOnAppShutdownHook)
    .filter(instance => !calledInstances?.has(instance as object))
    .map(async instance => {
      // Shutdown hooks run at most once per instance, even when they fail.
      calledInstances?.add(instance as object);
      return (instance as any as OnApplicationShutdown).onApplicationShutdown(
        signal,
      );
    })
    .toArray();
}

/**
 * Calls the `onApplicationShutdown` function on the module and its children
 * (providers / controllers).
 *
 * @param moduleRef The module which will be initialized
 * @param signal
 * @param calledInstances Optional set of instances whose hook has already
 * been triggered. Instances in the set are skipped; every triggered
 * instance is added to the set exactly once.
 */
export async function callAppShutdownHook(
  moduleRef: Module,
  signal?: string,
  calledInstances?: WeakSet<object>,
): Promise<any> {
  const providers = moduleRef.getNonAliasProviders();
  // Module (class) instance is the first element of the providers array
  // Lifecycle hook has to be called once all classes are properly initialized
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
      callOperator(groupedInstances.get(level)!, signal, calledInstances),
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
  // Call the instance itself
  const moduleClassInstance = moduleClassHost.instance;
  if (
    moduleClassInstance &&
    hasOnAppShutdownHook(moduleClassInstance) &&
    moduleClassHost.isDependencyTreeStatic() &&
    !calledInstances?.has(moduleClassInstance)
  ) {
    calledInstances?.add(moduleClassInstance);
    try {
      await moduleClassInstance.onApplicationShutdown(signal);
    } catch (err) {
      Logger.error(err, (err as Error)?.stack);
    }
  }
}
