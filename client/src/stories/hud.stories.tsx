import { Button } from "@/components/primitives/Button";
import useGameStore from "@/stores/game";
import { TopBar } from "@hud/TopBar";
import type { Story } from "@ladle/react";
import { useEffect } from "react";

export const TopBarStory: Story = () => {
  const setShip = useGameStore.use.setShip();
  const ship = useGameStore.use.ship();

  useEffect(() => {
    setShip({
      warp_power: 100,
      warp_power_capacity: 100,
      shields: 100,
      max_shields: 100,
      fighters: 100,
      max_fighters: 100,
    });
  }, [setShip]);

  return (
    <div className="relative w-full h-screen bg-gray-500">
      <TopBar />

      <div className="flex flex-col gap-2">
        <Button
          onClick={() => {
            setShip({ warp_power: ship.warp_power + 10 });
          }}
        >
          Increment Fuel
        </Button>
        <Button
          onClick={() => {
            setShip({ warp_power: ship.warp_power - 10 });
          }}
        >
          Decrement Fuel
        </Button>
        <Button
          onClick={() => {
            setShip({ shields: ship.shields! + 10 });
          }}
        >
          Increment Shields
        </Button>
        <Button
          onClick={() => {
            setShip({ shields: ship.shields! - 10 });
          }}
        >
          Decrement Shields
        </Button>
      </div>
    </div>
  );
};
