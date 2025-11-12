import useGameStore from "@/stores/game";
import {
  EnvelopeSimpleIcon,
  GearSixIcon,
  PathIcon,
  PlanetIcon,
  UserIcon,
  WarningDiamondIcon,
} from "@phosphor-icons/react";
import { Badge, BadgeTitle } from "./primitives/Badge";
import { Separator } from "./primitives/Separator";

export const SectorDetailBadges = () => {
  const sector = useGameStore.use.sector?.();

  const playerCount = sector?.players?.length ?? 0;
  const salvageCount = sector?.salvage?.length ?? 0;
  const laneCount = sector?.adjacent_sectors?.length ?? 0;

  return (
    <div className="flex flex-col gap-3 min-w-30 flex-1 max-w-44">
      <div className="flex flex-col gap-1.5 flex-1">
        <Badge
          variant="secondary"
          border="elbow"
          className="w-full elbow-offset-0 justify-between bg-background/60 "
        >
          <UserIcon weight="bold" />
          <BadgeTitle>{playerCount}</BadgeTitle>
        </Badge>
        <Badge
          variant="secondary"
          border="elbow"
          className="w-full elbow-offset-0 justify-between bg-background/60"
        >
          <GearSixIcon weight="bold" />
          <BadgeTitle>{salvageCount}</BadgeTitle>
        </Badge>
        <Badge
          variant="secondary"
          border="elbow"
          className="w-full elbow-offset-0 justify-between bg-background/60"
        >
          <PathIcon weight="bold" />
          <BadgeTitle>{laneCount}</BadgeTitle>
        </Badge>
        <Badge
          variant="secondary"
          border="elbow"
          className="w-full elbow-offset-0 justify-between bg-background/60"
        >
          <PlanetIcon weight="bold" />
          <BadgeTitle>0</BadgeTitle>
        </Badge>
        <Badge
          variant="secondary"
          border="elbow"
          className="w-full elbow-offset-0 justify-between bg-background/60"
        >
          <EnvelopeSimpleIcon />
          <BadgeTitle>0</BadgeTitle>
        </Badge>
      </div>
      <Separator variant="dotted" className="w-full text-white/20 h-[12px]" />
      <div className="flex flex-col gap-2 elbow elbow-size-2 flex-1 elbow-offset-0 items-center justify-center w-full bg-accent/30 motion-safe:bg-accent/20 motion-safe:backdrop-blur-sm">
        <WarningDiamondIcon size={28} weight="bold" />
        <BadgeTitle className="opacity-50">HOSTILE</BadgeTitle>
      </div>
    </div>
  );
};
