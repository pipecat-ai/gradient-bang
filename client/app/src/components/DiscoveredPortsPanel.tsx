import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";

/*
const DiscoveredPortHistoryRow = ({
  port,
  sector_id,
  last_visited,
}: {
  port: Port;
  sector_id: number;
  last_visited: string;
}) => {
  const visited = new Date(last_visited).toLocaleString("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <tr>
      <td className="py-1 text-agent w-16 whitespace-nowrap ">{sector_id}</td>
      <td className="py-1 whitespace-nowrap">{port.code}</td>
      <td className="py-1 text-right w-24 whitespace-nowrap">{visited}</td>
    </tr>
  );
};
*/

export const DiscoveredPortsPanel = () => {
  return (
    <Card withElbows={true} className="flex w-full h-full bg-black">
      <CardHeader>
        <PanelTitle>Discovered Ports</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left bg-background border-b border-border">
            <tr>
              <th className="py-1 w-18 whitespace-nowrap uppercase">Sector</th>
              <th className="py-1 whitespace-nowrap uppercase">Name</th>
              <th className="py-1 text-right w-24 whitespace-nowrap uppercase">
                Last Visited
              </th>
            </tr>
          </thead>
          <tbody>
            {/* sectorsWithPorts.map((sectorWithPort: MapSector) => (
              <DiscoveredPortHistoryRow
                key={sectorWithPort.port?.code}
                sector_id={sectorWithPort.sector_id}
                last_visited={sectorWithPort.last_visited as string}
                port={sectorWithPort.port as Port}
              />
            ))} */}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
