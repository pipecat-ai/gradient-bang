import { useEffect } from "react"

import useGameStore from "@/stores/game"
import { calculatePlayerRank, didPlayerRankUp } from "@/utils/leaderboard"

const CATEGORIES: LeaderboardCategory[] = ["wealth", "trading", "exploration", "territory"]

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
}
