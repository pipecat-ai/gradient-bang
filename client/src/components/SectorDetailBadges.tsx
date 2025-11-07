import useGameStore from "@/stores/game";
import { GearSixIcon, PathIcon, UserIcon } from "@phosphor-icons/react";
import { Badge, BadgeTitle } from "./primitives/Badge";

export const SectorDetailBadges = () => {
  const sector = useGameStore.use.sector?.();

  const playerCount = sector?.players?.length ?? 0;
  const salvageCount = sector?.salvage?.length ?? 0;
  const laneCount = sector?.adjacent_sectors?.length ?? 0;

  return (
    <div className="flex flex-row gap-2">
      <Badge
        variant="secondary"
        border="elbow"
        size="sm"
        className="flex-1 elbow-offset-0"
      >
        <UserIcon weight="bold" />
        <BadgeTitle>{playerCount}</BadgeTitle>
      </Badge>
      <Badge
        variant="secondary"
        border="elbow"
        size="sm"
        className="flex-1 elbow-offset-0"
      >
        <GearSixIcon weight="bold" />
        <BadgeTitle>{salvageCount}</BadgeTitle>
      </Badge>
      <Badge
        variant="secondary"
        border="elbow"
        size="sm"
        className="flex-1 elbow-offset-0"
      >
        <PathIcon weight="bold" />
        <BadgeTitle>{laneCount}</BadgeTitle>
      </Badge>
    </div>
  );
};
