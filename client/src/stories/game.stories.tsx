import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";

export const Init: Story = () => {
  const gameStore = useGameStore();

  return (
    <ul>
      <li>Credits: {gameStore.credits}</li>
      <li>Current Sector: {gameStore.sector?.id || "Unknown"}</li>
      <li>Ship: {gameStore.ship?.ship_name || "Unknown"}</li>
      <li>
        Warp: {gameStore.ship?.warp_power || "Unknown"}/
        {gameStore.ship?.warp_power_capacity || "Unknown"}
      </li>
      <li>
        Cargo:
        <ul>
          <li>FO: {gameStore.ship?.cargo.fuel_ore}</li>
          <li>OG: {gameStore.ship?.cargo.organics}</li>
          <li>EQ: {gameStore.ship?.cargo.equipment}</li>
        </ul>
      </li>
    </ul>
  );
};

Init.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
};

export const Status: Story = () => <div>Status</div>;

Status.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
};
