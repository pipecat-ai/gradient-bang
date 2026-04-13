import { useCallback, useEffect } from "react"

import { MedalIcon } from "@phosphor-icons/react"

import { LeaderboardPanel } from "@/components/panels/LeaderboardPanel"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

const LEADERBOARD_URL =
  (import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1") +
  (import.meta.env.VITE_SERVER_LEADERBOARD_ENDPOINT ?? "/leaderboard_resources")

const WORLD_EVENTS_URL =
  (import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1") + "/world_events_list"

const WORLD_EVENTS_CACHE_TTL = 1000 * 60 * 1 // 1 minute

async function fetchLeaderboardForScope(scope: "global" | "event") {
  const { playerEvent } = useGameStore.getState()
  const url =
    scope === "event" && playerEvent ?
      `${LEADERBOARD_URL}?event_id=${playerEvent.event_id}`
    : LEADERBOARD_URL
  const response = await fetch(url)
  const data = await response.json()
  useGameStore.getState().setLeaderboardDialogData(data, scope)
}

async function fetchWorldEvents() {
  try {
    const response = await fetch(WORLD_EVENTS_URL)
    const data = await response.json()
    if (data.success) {
      useGameStore.getState().setWorldEvents(data.events)
    }
  } catch (e) {
    console.debug("[LEADERBOARD] World events fetch failed", e)
  }
}

export const Leaderboard = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const leaderboardScope = useGameStore((state) => state.leaderboardScope)
  const leaderboardDialogScope = useGameStore((state) => state.leaderboardDialogScope)

  // Fetch dialog data on open and when scope changes
  useEffect(() => {
    if (activeModal?.modal !== "leaderboard") return

    // Refetch if scope changed or no dialog data yet
    if (leaderboardDialogScope !== leaderboardScope) {
      fetchLeaderboardForScope(leaderboardScope)
    }

    // Fetch world events (with TTL check)
    const worldEventsLastUpdated = useGameStore.getState().worldEventsLastUpdated
    if (
      !worldEventsLastUpdated ||
      new Date(worldEventsLastUpdated).getTime() + WORLD_EVENTS_CACHE_TTL <= Date.now()
    ) {
      fetchWorldEvents()
    }
  }, [activeModal, leaderboardScope, leaderboardDialogScope])

  const handleScopeChange = useCallback((scope: "global" | "event") => {
    useGameStore.getState().setLeaderboardScope(scope)
    // The useEffect above will detect the mismatch and refetch
  }, [])

  return (
    <BaseDialog modalName="leaderboard" title="Leaderboard" size="3xl">
      <Card elbow={true} size="default" className="w-full h-full bg-black shadow-2xl">
        <CardHeader>
          <CardTitle className="heading-2 flex flex-row items-center gap-2">
            <MedalIcon size={24} weight="bold" />
            Leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent className="h-full min-h-0">
          <LeaderboardPanel onScopeChange={handleScopeChange} />
        </CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button
              onClick={() => setActiveModal(undefined)}
              variant="secondary"
              className="flex-1"
            >
              Close
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
