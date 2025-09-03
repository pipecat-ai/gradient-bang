import {
  Card,
  CardContent,
  Divider,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import usePortStore from "../stores/port";

export const PortInfoPanel = () => {
  const { port } = usePortStore();
  return (
    <Card
      className="absolute top-panel left-panel w-2/3 text-xs"
      background="grid"
      withElbows={true}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Code:</span>
            <span>{port?.code as string}</span>
          </div>
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Class:</span>
            <span>{port?.class as unknown as string}</span>
          </div>
        </div>
        <Divider decoration="plus" />
        <PanelTitle>Stock</PanelTitle>
        <div className="flex flex-col gap-2">
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Fuel Ore:</span>
            <span>{port?.stock.FO || 0}</span>
          </div>
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Organics:</span>
            <span>{port?.stock.OG || 0}</span>
          </div>
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Equipment:</span>
            <span>{port?.stock.EQ || 0}</span>
          </div>
        </div>

        <Divider decoration="plus" />
        <PanelTitle>Trade</PanelTitle>
        <div className="flex flex-col gap-2">
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Buys:</span>
            <span>{port?.buys?.length ? port.buys.join(", ") : "Nothing"}</span>
          </div>
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Sells:</span>
            <span>
              {port?.sells?.length ? port.sells.join(", ") : "Nothing"}
            </span>
          </div>
        </div>

        <Divider decoration="plus" />
        <PanelTitle>Prices</PanelTitle>
        <div className="flex flex-col gap-2">
          {port?.prices &&
            Object.entries(port.prices).map(([resource, price]) => (
              <div
                key={resource}
                className="flex flex-row gap-4 justify-between"
              >
                <span className="font-extrabold capitalize">
                  {resource.replace("_", " ")}:
                </span>
                <span>{price}</span>
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
};
