import { Button } from "@/components/primitives/Button";
import { ButtonGroup } from "@/components/primitives/ButtonGroup";
import useGameStore from "@/stores/game";
import { cn } from "@/utils/tailwind";
import {
  ChatTeardropDotsIcon,
  CheckSquareOffsetIcon,
  CrosshairSimpleIcon,
  PlanetIcon,
  RocketLaunchIcon,
  SwapIcon,
} from "@phosphor-icons/react";
import * as React from "react";

export const ScreenMenuItem = ({
  children,
  active = false,
  label,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  label: string;
  onClick: () => void;
}) => {
  return (
    <Button
      variant="tab"
      size="tab"
      active={active}
      role="tab"
      aria-selected={active}
      aria-controls="#screen-container"
      aria-label={label}
      onClick={onClick}
    >
      <span
        className={cn(
          "absolute inset-0 cross-lines-subtle/30 z-1 pointer-events-none animate-in zoom-in-0 duration-300 ease-in-out",
          active ? "block" : "hidden"
        )}
        aria-hidden="true"
      />

      {React.isValidElement(children)
        ? React.cloneElement(children, {
            weight: active ? "fill" : "regular",
          } as React.ComponentProps<React.ElementType>)
        : (children satisfies React.ReactNode)}
    </Button>
  );
};

export const ScreenMenu = () => {
  const activeScreen = useGameStore.use.activeScreen?.();
  const setActiveScreen = useGameStore.use.setActiveScreen?.();

  const tabs = [
    { id: "self", label: "Self", icon: <RocketLaunchIcon /> },
    { id: "messaging", label: "Messaging", icon: <ChatTeardropDotsIcon /> },
    { id: "trading", label: "Trading", icon: <SwapIcon /> },
    { id: "map", label: "Map", icon: <PlanetIcon /> },
    { id: "tasks", label: "Tasks", icon: <CheckSquareOffsetIcon /> },
    { id: "combat", label: "Combat", icon: <CrosshairSimpleIcon /> },
  ];
  return (
    <div className="mask-[linear-gradient(to_bottom,transparent,black_20px)] p-ui-sm pt-0">
      <ButtonGroup className="relative flex flex-row gap-1">
        {tabs.map((tab) => (
          <ScreenMenuItem
            key={tab.id}
            label={tab.label}
            active={activeScreen === tab.id}
            onClick={() => {
              if (activeScreen === tab.id) {
                setActiveScreen(undefined);
                return;
              }
              setActiveScreen(tab.id as UIScreen);
            }}
          >
            {tab.icon}
          </ScreenMenuItem>
        ))}
      </ButtonGroup>
    </div>
  );
};
