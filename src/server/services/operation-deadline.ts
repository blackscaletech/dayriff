import {AsyncLocalStorage} from 'node:async_hooks';
import {ServiceError} from '../errors.js';

export const PLAN_OPERATION_TIMEOUT_MS = 120_000;
const operation = new AsyncLocalStorage<AbortSignal>();
export function planOperationSignal(): AbortSignal | undefined {return operation.getStore();}
export function assertPlanActive(): void {
  if (operation.getStore()?.aborted) throw new ServiceError('This update took too long. Your saved plan is still here; please try again.', 504, 'PLAN_TIMEOUT');
}
/** One deadline spans interpretation, discovery, routing and metadata; nested calls cannot reset it. */
export async function withPlanDeadline<T>(task: () => Promise<T>, timeoutMs = PLAN_OPERATION_TIMEOUT_MS): Promise<T> {
  if (operation.getStore()) {assertPlanActive(); return task();}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return operation.run(controller.signal, async () => {
    try {const value = await task(); assertPlanActive(); return value;}
    catch (error) {assertPlanActive(); throw error;}
    finally {clearTimeout(timer);}
  });
}
