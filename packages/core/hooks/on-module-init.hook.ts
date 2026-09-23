import type { OnModuleInit } from '@nestjs/common';
import { isFunction, isNil } from '@nestjs/common/internal';
import { iterate } from 'iterare';
import { Module } from '../injector/module.js';
import { getInstancesGroupedByHierarchyLevel } from './utils/get-instances-grouped-by-hierarchy-level.js';
import { getSortedHierarchyLevels } from './utils/get-sorted-hierarchy-levels.js';

/**
 * Returns true or false if the given instance has a `onModuleInit` function
 *
 * @param instance The instance which should be checked
 */
function hasOnModuleInitHook(instance: unknown): instance is OnModuleInit {
  return isFunction((instance as OnModuleInit).onModuleInit);
}

/**
 * Calls the given instances
 */
function callOperator(
  instances: unknown[],
  calledInstances?: WeakSet<object>,
): Promise<any>[] {
  return iterate(instances)
    .filter(instance => !isNil(instance))
    .filter(hasOnModuleInitHook)
    .filter(instance => !calledInstances?.has(instance as object))
    .map(async instance => {
      calledInstances?.add(instance as object);
      try {
        await (instance as any as OnModuleInit).onModuleInit();
      } catch (err) {
        // Unmark the instance so a retry can complete the hook for it.
        calledInstances?.delete(instance as object);
        throw err;
      }
    })
    .toArray();
}

/**
 * Calls the `onModuleInit` function on the module and its children
 * (providers / controllers).
 *
 * @param moduleRef The module which will be initialized
 * @param calledInstances Optional set of instances whose hook has already
 * been triggered. Instances in the set are skipped; instances are added to
 * the set as soon as their hook starts running and removed again if the
 * hook fails, so a retry only completes what is missing.
 */
export async function callModuleInitHook(
  moduleRef: Module,
  calledInstances?: WeakSet<object>,
): Promise<void> {
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

  const levels = getSortedHierarchyLevels(groupedInstances);
  for (const level of levels) {
    await Promise.all(callOperator(groupedInstances.get(level)!, calledInstances));
  }

  // Call the instance itself
  const moduleClassInstance = moduleClassHost.instance;
  if (
    moduleClassInstance &&
    hasOnModuleInitHook(moduleClassInstance) &&
    moduleClassHost.isDependencyTreeStatic() &&
    !calledInstances?.has(moduleClassInstance)
  ) {
    calledInstances?.add(moduleClassInstance);
    try {
      await moduleClassInstance.onModuleInit();
    } catch (err) {
      calledInstances?.delete(moduleClassInstance);
      throw err;
    }
  }
}
