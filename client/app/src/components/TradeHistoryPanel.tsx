import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
/*
const IconMap = {
  retro_organics: <PlantIcon size={18} weight="duotone" />,
  quantum_foam: <NutIcon size={18} weight="duotone" />,
  neuro_symbolics: <LightningIcon size={18} weight="duotone" />,
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
};*/

export const TradeHistoryPanel = () => {
  return (
    <Card withElbows={false} className="flex w-full h-full bg-black">
      <CardHeader>
        <PanelTitle>Trade History</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left bg-background border-b border-border">
            <tr>
              <th className="py-2 uppercase">Timestamp</th>
              <th className="py-2 uppercase">Commodity</th>
              <th className="py-2 uppercase">Type</th>
              <th className="py-2 uppercase">Units</th>
              <th className="py-2 uppercase">Price per unit</th>
              <th className="py-2 uppercase">Total price</th>
            </tr>
          </thead>
          <tbody>
            {/* trades.map((movement: TradeHistoryItem) => (
              <TradeHistoryRow key={movement.timestamp} item={movement} />
            ))} */}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
