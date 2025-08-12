import {
  Card,
  CardContent,
  CardHeader,
  CheckIcon,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import type { MovementHistory } from "../GameContext";
import { useGameManager } from "../hooks/useGameManager";

const MovementHistoryRow = ({ item }: { item: MovementHistory }) => {
  return (
    <tr>
      <td className="py-0.5 vkui:text-subtle">[{item.timestamp}]</td>
      <td className="py-0.5">{item.from}</td>
      <td className="py-0.5">{item.to}</td>
      <td className="py-0.5 vkui:text-agent">
        {item.port && <CheckIcon size={16} />}
      </td>
    </tr>
  );
};

export const MovementHistoryPanel = () => {
  const { game } = useGameManager();
  return (
    <Card
      noElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Movement History</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left vkui:bg-background border-b">
            <tr>
              <th className="py-1">Timestamp</th>
              <th>From</th>
              <th>To</th>
              <th>Port</th>
            </tr>
          </thead>
          <tbody>
            {game.movementHistory.map((movement) => (
              <MovementHistoryRow key={movement.timestamp} item={movement} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
