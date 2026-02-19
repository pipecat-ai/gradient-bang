import { RHSPanelContent } from "@/components/panels/RHSPanelContainer"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"

const CATEGORY_LABELS: Record<LeaderboardCategory, string> = {
  wealth: "Wealth",
  trading: "Trading",
  exploration: "Exploration",
  territory: "Territory",
}

const CATEGORIES: LeaderboardCategory[] = ["wealth", "trading", "exploration", "territory"]

export const RankPanel = () => {
  const playerCategoryRank = useGameStore((state) => state.playerCategoryRank)

  return (
    <RHSPanelContent>
      <Card>
        <CardHeader>
          <CardTitle>Global Ranking</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!playerCategoryRank ?
            <p className="text-muted-foreground text-sm">No ranking data</p>
          : CATEGORIES.map((category) => {
              const rank = playerCategoryRank[category]
              if (!rank) return null
              return (
                <div key={category} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{CATEGORY_LABELS[category]}</span>
                  <div className="flex items-center gap-2 text-right">
                    <span className="font-bold">
                      #{rank.rank}
                      <span className="text-muted-foreground font-normal">
                        /{rank.total_players}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs w-16">
                      {rank.to_next_rank > 0 ? `+${rank.to_next_rank}` : "—"}
                    </span>
                  </div>
                </div>
              )
            })
          }
        </CardContent>
      </Card>
    </RHSPanelContent>
  )
}
