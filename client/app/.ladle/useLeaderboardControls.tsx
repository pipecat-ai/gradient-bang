import { button, folder, useControls } from "leva"

import useGameStore from "@/stores/game"
import { calculatePlayerRank } from "@/utils/leaderboard"

import { LEADERBOARD_CATEGORY_KEYS } from "@/types/constants"
import { LEADERBOARD_DATA_MOCK } from "@/mocks/misc.mock"

const CATEGORIES: LeaderboardCategory[] = ["wealth", "trading", "exploration", "territory"]

const mockWithPlayerAtTop = (category: LeaderboardCategory) => {
  const state = useGameStore.getState()
  const playerId = state.character_id

  if (!playerId) {
    console.warn(`[Leaderboard] No player ID set, skipping mock injection`)
    return
  }

  const rankKey = LEADERBOARD_CATEGORY_KEYS[category]
  const existing =
    (LEADERBOARD_DATA_MOCK as unknown as Record<string, Record<string, unknown>[]>)[category] ?? []
  const rest = existing.filter((e) => e.player_id !== playerId)
  const match = existing.find((e) => e.player_id === playerId)
  const topValue = rest.length > 0 ? (Number(rest[0][rankKey]) || 0) + 1 : 1

  const playerEntry = match
    ? { ...match, [rankKey]: topValue }
    : {
        player_id: playerId,
        player_name: `Player [${playerId.slice(0, 6)}]`,
        [rankKey]: topValue,
      }

  const mockData = {
    ...LEADERBOARD_DATA_MOCK,
    [category]: [playerEntry, ...rest],
  }

  state.setLeaderboardData(mockData as unknown as LeaderboardResponse)
  console.log(`[Leaderboard] Set mock with player at top of ${category}`)
}

const rankCategory = (category: LeaderboardCategory) => {
  const state = useGameStore.getState()
  const playerId = state.character_id
  const leaderboardData = state.leaderboard_data

  if (!playerId) {
    console.warn(`[Leaderboard] No player ID set, skipping rank calculation`)
    return
  }

  if (!leaderboardData) {
    console.warn(`[Leaderboard] No leaderboard data set, skipping rank calculation`)
    return
  }

  const categoryData = leaderboardData[category]
  const rank = calculatePlayerRank(playerId, category, categoryData)
  state.setPlayerCategoryRank(category, rank)
  console.log(`[Leaderboard] ${category} rank:`, rank)
}

export const useLeaderboardControls = () => {
  const [, set] = useControls(() => ({
    Leaderboard: folder(
      {
        ["Player ID"]: {
          value: useGameStore.getState().character_id ?? "",
          onChange: (v: string) => {
            useGameStore.getState().setCharacterId(v)
          },
        },
        ["Set Leaderboard Mock"]: button(() => {
          const setLeaderboardData = useGameStore.getState().setLeaderboardData
          setLeaderboardData(LEADERBOARD_DATA_MOCK as unknown as LeaderboardResponse)
        }),
        ...Object.fromEntries(
          CATEGORIES.map((category) => [
            `Mock #1: ${category}`,
            button(() => mockWithPlayerAtTop(category)),
          ])
        ),
        ...Object.fromEntries(
          CATEGORIES.map((category) => [`Rank: ${category}`, button(() => rankCategory(category))])
        ),
        ["Rank: All"]: button(() => CATEGORIES.forEach(rankCategory)),
      },
      { collapsed: true, order: 4 }
    ),
  }))

  return set
}
