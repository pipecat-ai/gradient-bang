import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { usePanelRef } from "../hooks/usePanelRef";
import useMapStore, { type MapSector } from "../stores/map";
import type { Port } from "../stores/port";

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
      <td className="py-0.5 text-agent">{sector_id}</td>
      <td className="py-0.5">{port.code}</td>
      <td className="py-0.5">{port.class}</td>
      <td className="py-0.5">{visited}</td>
    </tr>
  );
};

export const PortHistoryPanel = () => {
  const panelRef = usePanelRef("ports_discovered");
  const { getDiscoveredPortSectors } = useMapStore();

  const sectorsWithPorts = getDiscoveredPortSectors();

  return (
    <Card
      ref={panelRef}
      withElbows={true}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Discovered Ports</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left bg-background border-b">
            <tr>
              <th className="py-1">Sector</th>
              <th>Name</th>
              <th>Class</th>
              <th>Last Visited</th>
            </tr>
          </thead>
          <tbody>
            {sectorsWithPorts.map((sectorWithPort: MapSector) => (
              <DiscoveredPortHistoryRow
                key={sectorWithPort.port?.code}
                sector_id={sectorWithPort.sector_id}
                last_visited={sectorWithPort.last_visited as string}
                port={sectorWithPort.port as Port}
              />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};
