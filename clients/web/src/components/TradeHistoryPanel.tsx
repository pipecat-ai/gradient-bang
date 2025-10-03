import { LightningIcon, NutIcon, PlantIcon } from "@phosphor-icons/react";
import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { usePanelRef } from "../hooks/usePanelRef";
import useTradeHistoryStore, { type TradeHistoryItem } from "../stores/trades";

const IconMap = {
  organics: <PlantIcon size={18} weight="duotone" />,
  fuel_ore: <NutIcon size={18} weight="duotone" />,
  equipment: <LightningIcon size={18} weight="duotone" />,
};

const TradeHistoryRow = ({ item }: { item: TradeHistoryItem }) => {
  return (
    <tr>
      <td className="py-1.5 text-agent flex flex-row gap-1 items-center">
        {IconMap[item.commodity as keyof typeof IconMap]} {item.commodity}
      </td>
      <td>{item.units}</td>
      <td
        className={item.trade_type === "buy" ? "text-active" : "text-inactive"}
      >
        {item.trade_type}
      </td>
      <td>{item.price_per_unit}</td>
      <td>{item.total_price}</td>
      <td className="text-subtle">
        [
        {new Date().toLocaleString("en-GB", {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
        ]
      </td>
    </tr>
  );
};

export const TradeHistoryPanel = () => {
  const panelRef = usePanelRef("trade_history");
  const { getTrades } = useTradeHistoryStore();

  const trades = getTrades();

  return (
    <Card
      ref={panelRef}
      withElbows={false}
      className="flex w-full h-full bg-black"
    >
      <CardHeader>
        <PanelTitle>Trade History</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left bg-background border-b">
            <tr>
              <th className="py-2">Timestamp</th>
              <th>Commodity</th>
              <th>Type</th>
              <th>Units</th>
              <th>Price per unit</th>
              <th>Total price</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((movement: TradeHistoryItem) => (
              <TradeHistoryRow key={movement.timestamp} item={movement} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
