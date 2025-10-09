import Game from "@/views/Game";
import type { Story } from "@ladle/react";

export const GameUI: Story = () => (
  <div className="relative w-full h-screen">
    <Game />
  </div>
);

GameUI.meta = {
  disconnectedStory: true,
};
