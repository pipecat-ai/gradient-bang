import useGameStore from "@/stores/game";
import MiniMap from "@hud/MiniMap";

import { PortBadge } from "@/components/PortBadge";
import { Card } from "@/components/primitives/Card";
import { Separator } from "@/components/primitives/Separator";
import { SectorBadge } from "@/components/SectorBadge";
import { SectorDetailBadges } from "@/components/SectorDetailBadges";

export const LHS = () => {
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);

  return (
    <div className="min-w-[400px] lhs-perspective flex flex-col gap-2 w-[700px]">
      <Card
        className="relative border-2 border-white/10 bg-transport p-0"
        elbow={true}
      >
        {sector && localMapData && (
          <MiniMap
            current_sector_id={sector.id}
            map_data={localMapData}
            maxDistance={2}
            showLegend={false}
            width={600}
            height={308}
          />
        )}
      </Card>
      <Separator variant="dotted" className="w-full text-white/20 h-[12px]" />
      <div className="flex flex-row gap-2">
        <SectorBadge />
        <PortBadge />
      </div>
      <Separator variant="dotted" className="w-full text-white/20 h-[12px]" />
      <SectorDetailBadges />
    </div>
  );
};
