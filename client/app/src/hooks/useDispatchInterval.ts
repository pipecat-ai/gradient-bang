import { useEffect, useRef } from "react"

import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import useGameStore from "@/stores/game"

import type { ActionType, GameAction } from "@/types/actions"

interface UseDispatchIntervalOptions<T> {
  data?: T // Current data - if undefined, will trigger initial fetch
  interval?: number | null // Refresh interval in ms (null = mount only)
  staleTime?: number // Only fetch if data older than this (ms)
  lastUpdated?: string | null // For stale time checking
  enabled?: boolean // Disable all fetching (default: true)
  debug?: boolean // Enable debug logging (default: false)
}

/**
 * Hook that dispatches an action on mount (if data is undefined) and optionally on an interval.
 *
 * @param actionType - The action type to dispatch
 * @param options - Configuration options
 * @returns Object containing `isFetching` state
 *
 * @example
 * ```tsx
 * const shipsData = useGameStore(state => state.ships);
 * const { isFetching } = useDispatchInterval("get-my-ships", {
 *   data: shipsData.data,
 *   interval: 5000,
 *   staleTime: 10000,
 *   lastUpdated: shipsData.last_updated,
 *   debug: true, // Enable logging
 * });
 * ```
 */
export const useDispatchInterval = <T>(
  actionType: ActionType,
  options: UseDispatchIntervalOptions<T> = {}
) => {
  const {
    data,
    interval = null,
    staleTime,
    lastUpdated,
    enabled = true,
    debug = false,
  } = options

  const { isConnected } = usePipecatConnectionState()
  const dispatchAction = useGameStore((state) => state.dispatchAction)
  const isFetching = useGameStore((state) =>
    Boolean(state.fetchPromises[actionType])
  )

  const hasFetchedRef = useRef(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastUpdatedRef = useRef(lastUpdated)
  const debugRef = useRef(debug)

  // Keep refs in sync with latest values
  useEffect(() => {
    lastUpdatedRef.current = lastUpdated
  }, [lastUpdated])

  useEffect(() => {
    debugRef.current = debug
  }, [debug])

  // Mount fetch - only if data is undefined
  useEffect(() => {
    const log = (msg: string) =>
      debugRef.current &&
      console.debug(`[useDispatchInterval:${actionType}] ${msg}`)

    if (!enabled) {
      log("Disabled, skipping")
      return
    }

    if (!isConnected) {
      log("Not connected, resetting hasFetched")
      hasFetchedRef.current = false
      return
    }

    if (hasFetchedRef.current) {
      log("Initial fetch already completed, skipping")
      return
    }

    if (data !== undefined) {
      log("Data already exists, skipping initial fetch")
      hasFetchedRef.current = true
      return
    }

    log("Dispatching initial fetch")
    hasFetchedRef.current = true
    dispatchAction({ type: actionType, async: true } as GameAction)
  }, [enabled, isConnected, data, dispatchAction, actionType])

  // Interval fetch with stale time checking
  useEffect(() => {
    const log = (msg: string) =>
      debugRef.current &&
      console.debug(`[useDispatchInterval:${actionType}] ${msg}`)

    if (!enabled || !isConnected || !interval) {
      log(
        `Interval not started (enabled=${enabled}, connected=${isConnected}, interval=${interval})`
      )
      return
    }

    log(`Starting interval (${interval}ms, staleTime=${staleTime}ms)`)

    intervalRef.current = setInterval(() => {
      // Read current lastUpdated value from ref at tick time
      const currentLastUpdated = lastUpdatedRef.current
      const lastTime = currentLastUpdated
        ? new Date(currentLastUpdated).getTime()
        : 0
      const isStale = !staleTime || lastTime < Date.now() - staleTime

      log(`Tick - lastUpdated=${currentLastUpdated}, isStale=${isStale}`)

      if (isStale) {
        log("Data stale, dispatching refresh")
        dispatchAction({ type: actionType, async: false } as GameAction)
      }
    }, interval)

    return () => {
      if (intervalRef.current) {
        log("Clearing interval")
        clearInterval(intervalRef.current)
      }
    }
  }, [enabled, isConnected, interval, staleTime, dispatchAction, actionType])

  return { isFetching }
}
