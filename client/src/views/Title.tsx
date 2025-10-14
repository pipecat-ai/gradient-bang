import { Settings } from "@/dialogs/Settings";
import useGameStore from "@/stores/game";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
} from "@pipecat-ai/voice-ui-kit";
import { useEffect } from "react";

export const Title = ({ onViewNext }: { onViewNext: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal();

  useEffect(() => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.start("title-screen");
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div className="absolute inset-0">
        <video
          src="/videos/title.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          className="w-full h-full object-cover pointer-events-none z-1"
        />
      </div>
      <div className="relative z-2 flex flex-col items-center justify-center h-full w-full">
        <div className="bg-black" id="title-screen">
          <Card size="xl" background="stripes">
            <CardHeader>
              <h1 className="text-white text-4xl font-bold">
                Placeholder Title Screen
              </h1>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center gap-2">
              <Button isFullWidth onClick={onViewNext}>
                Start
              </Button>
              <Button
                isFullWidth
                onClick={() => setActiveModal("settings")}
                variant="secondary"
              >
                Settings
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
      <Settings />
    </div>
  );
};

export default Title;
