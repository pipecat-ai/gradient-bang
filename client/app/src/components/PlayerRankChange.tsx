import { useEffect } from "react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

const CATEGORY_LABELS: Record<LeaderboardCategory, string> = {
  wealth: "Wealth",
  trading: "Trading",
  exploration: "Exploration",
  territory: "Territory",
}

const DISPLAY_TIME = 5000

const CATEGORIES: LeaderboardCategory[] = ["wealth", "trading", "exploration", "territory"]

export const PlayerRankChange = () => {
  const rankChanged = useGameStore((state) => state.notifications.rankChanged)
  const playerCategoryRank = useGameStore((state) => state.playerCategoryRank)
  const playerCategoryRankPrev = useGameStore((state) => state.playerCategoryRankPrev)
  const setNotifications = useGameStore((state) => state.setNotifications)

  useEffect(() => {
    if (!rankChanged) return

    useAudioStore.getState().playSound("chime8")

    const timeout = setTimeout(() => {
      setNotifications({ rankChanged: false })
    }, DISPLAY_TIME)

    return () => clearTimeout(timeout)
  }, [rankChanged, setNotifications])

  if (!rankChanged || !playerCategoryRank) return null

  console.log("PEW PEW PEW")

  return (
    <div className="fixed inset-0 bg-red-500 border p-4 z-50">
      <div className="font-bold mb-2">Rank Changed!</div>
      {CATEGORIES.map((category) => {
        const curr = playerCategoryRank[category]
        const prev = playerCategoryRankPrev?.[category]
        if (!curr) return null
        const changed = prev && prev.rank !== curr.rank
        return (
          <div
            key={category}
            className={`flex justify-between gap-4 ${changed ? "text-yellow-300 font-bold" : "text-muted-foreground"}`}
          >
            <span>{CATEGORY_LABELS[category]}</span>
            <span>
              {changed && prev ? `#${prev.rank} → ` : ""}#{curr.rank}/{curr.total_players}
            </span>
          </div>
        )
      })}
    </div>
  )
}
