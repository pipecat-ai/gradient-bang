import useGameStore from "@/stores/game";
import { formatDate, formatTimeAgoOrDate } from "@/utils/date";
import { cn } from "@/utils/tailwind";
import { CheckIcon } from "@phosphor-icons/react";
import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";

const MovementHistoryRow = ({ item }: { item: MovementHistory }) => {
  return (
    <tr className={cn(!item.last_visited && "bg-muted")}>
      <td className="py-0.5 text-subtle">[{formatDate(item.timestamp)}]</td>
      <td className="py-0.5">{item.from}</td>
      <td className="py-0.5">{item.to}</td>
      <td className="py-0.5 text-agent">
        {!!item.port && <CheckIcon size={16} />}
      </td>
      <td className="py-0.5 text-agent">
        {item.last_visited
          ? formatTimeAgoOrDate(item.last_visited)
          : "Discovered"}
      </td>
    </tr>
  );
};

export const MovementHistoryPanel = () => {
  const movementHistory = useGameStore((state) => state.movement_history);
  return (
    <Card withElbows={true} className="flex w-full h-full bg-black">
      <CardHeader>
        <PanelTitle>Movement History</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left bg-background border-b border-border">
            <tr>
              <th className="py-1 uppercase">Timestamp</th>
              <th className="py-1 uppercase">From</th>
              <th className="py-1 uppercase">To</th>
              <th className="py-1 uppercase">Port</th>
              <th className="py-1 uppercase">Last Visited</th>
            </tr>
          </thead>
          <tbody>
            {[...movementHistory].reverse().map((movement: MovementHistory) => (
              <MovementHistoryRow key={movement.timestamp} item={movement} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
