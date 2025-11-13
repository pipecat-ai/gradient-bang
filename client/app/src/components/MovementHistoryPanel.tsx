import useGameStore from "@/stores/game";
import { formatDate, formatTimeAgoOrDate } from "@/utils/date";
import { CheckIcon } from "@phosphor-icons/react";
import { Card, CardContent } from "./primitives/Card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableHeadText,
  TableRow,
} from "./primitives/Table";

const MovementHistoryRow = ({ item }: { item: MovementHistory }) => {
  return (
    <TableRow block className="text-muted-foreground">
      <TableCell block>{formatDate(item.timestamp)}</TableCell>
      <TableCell block className="text-center">
        {item.from}
      </TableCell>
      <TableCell block className="text-center">
        {item.to}
      </TableCell>
      <TableCell block className="text-fuel text-center">
        {!!item.port && <CheckIcon size={16} className="mx-auto" />}
      </TableCell>
      <TableCell block className="">
        {item.last_visited
          ? formatTimeAgoOrDate(item.last_visited)
          : "Discovered"}
      </TableCell>
    </TableRow>
  );
};

export const MovementHistoryPanel = () => {
  const movementHistory = useGameStore((state) => state.movement_history);

  return (
    <Card className="flex w-full h-full bg-black" size="none">
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <Table block className="text-xs">
          <TableHeader block>
            <TableRow>
              <TableHead
                block
                className="uppercase bg-card border-b border-white"
              >
                Arrival
              </TableHead>
              <TableHead
                block
                className="uppercase bg-card border-b border-white"
              >
                <TableHeadText>From</TableHeadText>
              </TableHead>
              <TableHead
                block
                className="uppercase bg-card border-b border-white"
              >
                <TableHeadText>To</TableHeadText>
              </TableHead>
              <TableHead
                block
                className="uppercase bg-card border-b border-white"
              >
                <TableHeadText>Port</TableHeadText>
              </TableHead>
              <TableHead
                block
                className="uppercase bg-card border-b border-white"
              >
                Previous Visit
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...movementHistory]
              .slice(-20)
              .reverse()
              .map((movement: MovementHistory) => (
                <MovementHistoryRow key={movement.timestamp} item={movement} />
              ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};
