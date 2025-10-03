import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { CheckIcon } from "lucide-react";
import { usePanelRef } from "../hooks/usePanelRef";
import useMovementHistoryStore, {
  type MovementHistory,
} from "../stores/history";

const MovementHistoryRow = ({ item }: { item: MovementHistory }) => {
  return (
    <tr>
      <td className="py-0.5 text-subtle">[{item.timestamp}]</td>
      <td className="py-0.5">{item.from}</td>
      <td className="py-0.5">{item.to}</td>
      <td className="py-0.5 text-agent">
        {!!item.port && <CheckIcon size={16} />}
      </td>
    </tr>
  );
};

export const MovementHistoryPanel = () => {
  const panelRef = usePanelRef("movement_history");
  const { history } = useMovementHistoryStore();

  return (
    <Card
      ref={panelRef}
      withElbows={true}
      className="flex w-full h-full bg-black"
    >
      <CardHeader>
        <PanelTitle>Movement History</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left bg-background border-b">
            <tr>
              <th className="py-1">Timestamp</th>
              <th>From</th>
              <th>To</th>
              <th>Port</th>
            </tr>
          </thead>
          <tbody>
            {history.map((movement: MovementHistory) => (
              <MovementHistoryRow key={movement.timestamp} item={movement} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
