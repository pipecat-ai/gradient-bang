import useGameStore from "@/stores/game";
import { LHS } from "@hud/LHS";
import MiniMap from "@hud/MiniMap";
import { RHS } from "@hud/RHS";
import { Divider, UserAudioControl } from "@pipecat-ai/voice-ui-kit";

export const ShipHUD = () => {
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);

  return (
    <div className="flex flex-row p-2 h-ui mt-auto gap-2">
      <LHS />
      <div className="min-w-[var(--hud-center)]">
        <div className="relative h-[var(--hud-center)]">
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector.id}
              map_data={localMapData}
              maxDistance={3}
              showLegend={false}
              width={330}
              height={330}
            />
          )}
        </div>
        <div className="flex flex-col gap-2 mt-2">
          <Divider className="w-full py-1.5" variant="dotted" />
          <UserAudioControl size="lg" variant="outline" />
        </div>
      </div>
      <RHS />
    </div>
  );
};
