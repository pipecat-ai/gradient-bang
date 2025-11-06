import { Button } from "@/components/primitives/Button";
import { ButtonGroup } from "@/components/primitives/ButtonGroup";
import { Separator } from "@/components/primitives/Separator";
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
import { AnimatePresence, motion } from "motion/react";

import * as React from "react";

export const ScreenMenuItem = ({
  children,
  active = false,
  label,
  onClick,
  onMouseEnter,
}: {
  children: React.ReactNode;
  active: boolean;
  label: string;
  onClick: () => void;
  onMouseEnter: () => void;
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
      onMouseEnter={onMouseEnter}
    >
      <span
        className={cn(
          "absolute inset-0 cross-lines-terminal-foreground/20 z-1 pointer-events-none animate-in zoom-in-0 duration-300 ease-in-out",
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
  const [hoveredTab, setHoveredTab] = React.useState<UIScreen | null>(null);
  const timerRef = React.useRef<NodeJS.Timeout | null>(null);

  const startFadeOutTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setHoveredTab(null);
    }, 1000);
  };

  const clearFadeOutTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleTabMouseEnter = (tabId: UIScreen) => {
    clearFadeOutTimer();
    setHoveredTab(tabId);
  };

  const tabs = [
    { id: "self", label: "Status", icon: <RocketLaunchIcon /> },
    { id: "trading", label: "Trading", icon: <SwapIcon /> },
    { id: "map", label: "Map", icon: <PlanetIcon /> },
    { id: "tasks", label: "Tasks", icon: <CheckSquareOffsetIcon /> },
    { id: "combat", label: "Combat", icon: <CrosshairSimpleIcon /> },
    { id: "messaging", label: "Messaging", icon: <ChatTeardropDotsIcon /> },
  ];
  return (
    <div className="flex flex-col gap-1 items-center user-select-none relative">
      <div
        className="mask-[linear-gradient(to_bottom,transparent_1px,black_20px)] pb-2"
        onMouseLeave={startFadeOutTimer}
      >
        <ButtonGroup className="relative flex flex-row gap-1 shadow-lg">
          {tabs.map((tab) => (
            <ScreenMenuItem
              key={tab.id}
              label={tab.label}
              active={activeScreen === tab.id}
              onMouseEnter={() => handleTabMouseEnter(tab.label as UIScreen)}
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
      <div className="text-xs uppercase tracking-widest font-bold text-center w-full">
        <AnimatePresence>
          {hoveredTab && (
            <motion.div
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1 }}
            >
              <div className="flex flex-row gap-4 items-center">
                <Separator className="w-auto flex-1 bg-muted-foreground/60" />
                <span className="bg-background/30 px-2 py-1">{hoveredTab}</span>
                <Separator className="w-auto flex-1 bg-muted-foreground/60" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
