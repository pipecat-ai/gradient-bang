import { ScreenContainer } from "@/screens/ScreenContainer";
import useGameStore from "@/stores/game";
import Game from "@/views/Game";
import ViewContainer from "@/views/ViewContainer";
import { AnimatedFrame } from "@fx/frame";
import type { Story } from "@ladle/react";

export const ScreenUI: Story = () => (
  <div className="relative w-full h-screen flex flex-col items-center justify-center bg-slate-800">
    <ScreenContainer />
    <footer className="absolute bottom-0 left-0 right-0 flex flex-row gap-2">
      <button onClick={() => useGameStore.getState().setActiveScreen("self")}>
        Self
      </button>
      <button
        onClick={() => useGameStore.getState().setActiveScreen("messaging")}
      >
        Messaging
      </button>
      <button
        onClick={() => useGameStore.getState().setActiveScreen("trading")}
      >
        Trading
      </button>
      <button onClick={() => useGameStore.getState().setActiveScreen("map")}>
        Map
      </button>
      <button onClick={() => useGameStore.getState().setActiveScreen("tasks")}>
        Tasks
      </button>
      <button onClick={() => useGameStore.getState().setActiveScreen("combat")}>
        Combat
      </button>
      <button onClick={() => useGameStore.getState().setActiveScreen()}>
        None
      </button>
    </footer>
    <AnimatedFrame />
  </div>
);

ScreenUI.meta = {
  disconnectedStory: true,
};

export const GameUI: Story = () => (
  <div className="relative w-full h-screen">
    <Game />
  </div>
);

GameUI.meta = {
  disconnectedStory: true,
};

export const ViewContainerUI: Story = () => (
  <div className="relative w-full h-screen">
    <ViewContainer />
  </div>
);

ViewContainerUI.meta = {
  disconnectedStory: true,
};
