import {
  Table,
  TableBody,
  TableCell,
  TableCellSeparator,
  TableHead,
  TableHeader,
  TableHeadText,
  TableRow,
} from "@/components/primitives/Table";
import { formatCurrency } from "@/utils/formatting";
import { MedalIcon } from "@phosphor-icons/react";

export const LeaderboardTable = ({
  leaderboardData,
}: {
  leaderboardData: LeaderboardPlayer[];
}) => {
  const data = leaderboardData.sort((a, b) => a.rank - b.rank);

  return (
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
            <TableHeadText>Net Worth</TableHeadText>
          </TableHead>
          <TableHead block>
            <TableHeadText>Sector Discovery</TableHeadText>
          </TableHead>
          <TableHead block>
            <TableHeadText>Total Resources</TableHeadText>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((player) => (
          <TableRow key={player.character_id} block>
            <TableCell
              block
              inset
              className="font-bold text-center border-r-transparent"
            >
              {player.rank}
            </TableCell>
            <TableCellSeparator />
            <TableCell block className="font-semibold">
              {player.name}
            </TableCell>
            <TableCell block className="text-center">
              {formatCurrency(
                player.bank_credits +
                  player.ship_credits +
                  player.ship_trade_in_value +
                  player.garrison_fighter_value
              )}
            </TableCell>
            <TableCell block className="text-center">
              {player.exploration_percent}%
            </TableCell>
            <TableCell block className="text-center">
              {formatCurrency(player.total_resources)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
