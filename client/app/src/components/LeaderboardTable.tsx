import { useState } from "react"

import { MedalIcon } from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import {
  Table,
  TableBody,
  TableCell,
  TableCellSeparator,
  TableHead,
  TableHeader,
  TableHeadText,
  TableRow,
} from "@/components/primitives/Table"
import { formatCurrency } from "@/utils/formatting"

export const LeaderboardTable = ({
  leaderboardData,
}: {
  leaderboardData: LeaderboardResponse
}) => {
  const [selectedTab, setSelectedTab] = useState("wealth")
  const data = leaderboardData.wealth
    .filter((p) => p.player_type === "human")
    .sort((a, b) => b.total_wealth - a.total_wealth)

  return (
    <>
      <div className="flex flex-row gap-2">
        <Button
          variant={selectedTab === "wealth" ? "default" : "secondary"}
          size="sm"
          onClick={() => setSelectedTab("wealth")}
        >
          Wealth
        </Button>
        <Button
          variant={selectedTab === "territory" ? "default" : "secondary"}
          size="sm"
          onClick={() => setSelectedTab("territory")}
        >
          Territory
        </Button>
        <Button
          variant={selectedTab === "trading" ? "default" : "secondary"}
          size="sm"
          onClick={() => setSelectedTab("trading")}
        >
          Trading
        </Button>
        <Button
          variant={selectedTab === "discovery" ? "default" : "secondary"}
          size="sm"
          onClick={() => setSelectedTab("discovery")}
        >
          Discovery
        </Button>
      </div>
      {selectedTab === "wealth" && (
        <Table block className="text-xs">
          <TableHeader block>
            <TableRow>
              <TableHead block className="w-8">
                <MedalIcon size={20} />
              </TableHead>
              <TableCellSeparator />
              <TableHead block className="w-full">
                Player Name
              </TableHead>
              <TableHead block>
                <TableHeadText>Ships Owned</TableHeadText>
              </TableHead>
              <TableHead block>
                <TableHeadText>Ship Value</TableHeadText>
              </TableHead>
              <TableHead block>
                <TableHeadText>Total Wealth</TableHeadText>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((player, i) => (
              <TableRow key={`character-${i}`} block>
                <TableCell
                  block
                  inset
                  className="font-bold text-center border-r-transparent"
                >
                  {i + 1}
                </TableCell>
                <TableCellSeparator />
                <TableCell block className="font-semibold">
                  {player.player_name}
                </TableCell>
                <TableCell block className="text-center">
                  {player.ships_owned}
                </TableCell>
                <TableCell block className="text-center">
                  {formatCurrency(player.ship_value)}
                </TableCell>
                <TableCell block className="text-center">
                  {formatCurrency(player.total_wealth)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {selectedTab === "trading" && (
        <Table block className="text-xs">
          <TableHeader block>
            <TableRow>
              <TableHead block className="w-8">
                <MedalIcon size={20} />
              </TableHead>
              <TableCellSeparator />
              <TableHead block className="w-full">
                Player Name
              </TableHead>
              <TableHead block>
                <TableHeadText>Total Trades</TableHeadText>
              </TableHead>
              <TableHead block>
                <TableHeadText>Trade Volume</TableHeadText>
              </TableHead>
              <TableHead block>
                <TableHeadText>Ports Visited</TableHeadText>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaderboardData.trading.filter((p) => p.player_type === "human").map((player, i) => (
              <TableRow key={`character-${i}`} block>
                <TableCell
                  block
                  inset
                  className="font-bold text-center border-r-transparent"
                >
                  {i + 1}
                </TableCell>
                <TableCellSeparator />
                <TableCell block className="font-semibold">
                  {player.player_name}
                </TableCell>
                <TableCell block className="text-center">
                  {player.total_trades}
                </TableCell>
                <TableCell block className="text-center">
                  {formatCurrency(player.total_trade_volume)}
                </TableCell>
                <TableCell block className="text-center">
                  {player.ports_visited}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {selectedTab === "territory" && (
        <Table block className="text-xs">
          <TableHeader block>
            <TableRow>
              <TableHead block className="w-8">
                <MedalIcon size={20} />
              </TableHead>
              <TableCellSeparator />
              <TableHead block className="w-full">
                Player Name
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaderboardData.territory.filter((p) => p.player_type === "human").map((player, i) => (
              <TableRow key={`character-${i}`} block>
                <TableCell
                  block
                  inset
                  className="font-bold text-center border-r-transparent"
                >
                  {i + 1}
                </TableCell>
                <TableCellSeparator />
                <TableCell block className="font-semibold">
                  {player.player_name}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {selectedTab === "discovery" && (
        <Table block className="text-xs">
          <TableHeader block>
            <TableRow>
              <TableHead block className="w-8">
                <MedalIcon size={20} />
              </TableHead>
              <TableCellSeparator />
              <TableHead block className="w-full">
                Player Name
              </TableHead>
              <TableHead block>
                <TableHeadText>Sectors Visited</TableHeadText>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaderboardData.exploration.filter((p) => p.player_type === "human").map((player, i) => (
              <TableRow key={`character-${i}`} block>
                <TableCell
                  block
                  inset
                  className="font-bold text-center border-r-transparent"
                >
                  {i + 1}
                </TableCell>
                <TableCellSeparator />
                <TableCell block className="font-semibold">
                  {player.player_name}
                </TableCell>
                <TableCell block className="text-center">
                  {player.sectors_visited}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
