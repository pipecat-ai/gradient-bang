import { LEADERBOARD_CATEGORY_KEYS } from "@/types/constants"

export function calculatePlayerRank(
  playerId: string,
  category: LeaderboardCategory,
  categoryData: LeaderboardResponse[LeaderboardCategory]
): PlayerLeaderboardCategoryRank {
  const rankKey = LEADERBOARD_CATEGORY_KEYS[category]

  const playerIndex = categoryData.findIndex((entry) => entry.player_id === playerId)

  if (playerIndex === -1) {
    return { rank: 0, total_players: 0, to_next_rank: 0 }
  }

  const rank = playerIndex + 1
  const total_players = categoryData.length
  const playerEntry = categoryData[playerIndex] as Record<string, unknown>
  const playerValue = Number(playerEntry[rankKey]) || 0
  const to_next_rank =
    playerIndex > 0
      ? (Number((categoryData[playerIndex - 1] as Record<string, unknown>)[rankKey]) || 0) -
        playerValue
      : 0

  return { rank, total_players, to_next_rank }
}

export function didPlayerRankUp(
  prev: Record<LeaderboardCategory, PlayerLeaderboardCategoryRank> | null,
  next: Record<LeaderboardCategory, PlayerLeaderboardCategoryRank> | null
): boolean {
  if (!prev || !next) return false

  return (Object.keys(next) as LeaderboardCategory[]).some((category) => {
    const prevRank = prev[category]?.rank ?? 0
    const nextRank = next[category]?.rank ?? 0
    return nextRank > 0 && (prevRank === 0 || nextRank < prevRank)
  })
}
