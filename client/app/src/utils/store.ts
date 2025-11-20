import type { StoreApi, UseBoundStore } from "zustand";

/**
 * Wait for a Zustand store condition to be met using subscribe.
 * Returns a Promise that resolves when the condition is satisfied.
 *
 * @param store - The Zustand store to subscribe to
 * @param selector - Function to extract the value from state
 * @param condition - Function that returns true when the condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 10000)
 * @returns Promise that resolves with the selected value when condition is met
 * @throws Error if timeout is reached before condition is met
 *
 * @example
 * // Wait for a single value
 * const sector = await waitForStoreCondition(
 *   useGameStore,
 *   (state) => state.sector,
 *   (sector) => sector !== undefined
 * );
 *
 * @example
 * // Wait for multiple values using object destructuring
 * const data = await waitForStoreCondition(
 *   useGameStore,
 *   (state) => ({ sector: state.sector, map: state.local_map_data }),
 *   (data) => data.sector !== undefined && data.map !== undefined
 * );
 */
export function waitForStoreCondition<TState, TValue>(
  store: UseBoundStore<StoreApi<TState>>,
  selector: (state: TState) => TValue,
  condition: (value: TValue) => boolean,
  timeoutMs: number = 10000
): Promise<TValue> {
  return new Promise((resolve, reject) => {
    // Check if condition is already met
    const currentState = store.getState();
    const currentValue = selector(currentState);
    if (condition(currentValue)) {
      resolve(currentValue);
      return;
    }

    // Setup timeout
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `[GAME] Timeout waiting for store condition after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);

    // Subscribe and wait for condition
    const unsubscribe = store.subscribe((state) => {
      const value = selector(state);
      if (condition(value)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(value);
      }
    });
  });
}
