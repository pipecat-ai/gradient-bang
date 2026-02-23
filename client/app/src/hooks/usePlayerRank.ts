import { useEffect } from "react"

import useGameStore from "@/stores/game"
import { calculatePlayerRank, didPlayerRankUp } from "@/utils/leaderboard"

const CATEGORIES: LeaderboardCategory[] = ["wealth", "trading", "exploration", "territory"]

const LEADERBOARD_URL =
  (import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1") +
  (import.meta.env.VITE_SERVER_LEADERBOARD_ENDPOINT ?? "/leaderboard_resources")

const POLL_INTERVAL_MS = 60_000

export const usePlayerRank = () => {
  useEffect(() => {
    const unsub = useGameStore.subscribe(
      (state) => state.leaderboard_data,
      (leaderboardData) => {
        console.debug("[GAME usePlayerRank] Leaderboard changed; checking rank", leaderboardData)

        const {
          character_id,
          playerCategoryRank: prev,
          setPlayerCategoryRank,
        } = useGameStore.getState()

        if (!character_id || !leaderboardData) return

        for (const category of CATEGORIES) {
          const categoryData = leaderboardData[category]
          const rank = calculatePlayerRank(character_id, category, categoryData)
          setPlayerCategoryRank(category, rank)
        }

        const next = useGameStore.getState().playerCategoryRank
        if (didPlayerRankUp(prev, next)) {
          console.debug("[GAME usePlayerRank] Rank changed", { prev, next })
          useGameStore.getState().setPlayerCategoryRankPrev(prev)
          useGameStore.getState().setNotifications({ rankChanged: true })
        }
      }
    )

    return unsub
  }, [])

  useEffect(() => {
    const pollLeaderboard = async () => {
      console.debug("[GAME] Polling leaderboard")
      try {
        const response = await fetch(LEADERBOARD_URL)
        const data = await response.json()
        useGameStore.getState().setLeaderboardData(data)
      } catch (e) {
        console.debug("[GAME] Leaderboard poll failed", e)
      }
    }

    const interval = setInterval(pollLeaderboard, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [])
}
