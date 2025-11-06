import { Button } from "@/components/primitives/Button";
import { Card, CardContent, CardHeader } from "@/components/primitives/Card";
import { Settings } from "@/dialogs/Settings";
import useGameStore from "@/stores/game";

export const Title = ({ onViewNext }: { onViewNext: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal();

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
        <Card elbow={true} variant="secondary" size="xl" className="min-w-lg">
          <CardHeader>
            <h1 className="text-white text-3xl font-bold uppercase">
              Placeholder Title Screen
            </h1>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center gap-5">
            <Button onClick={onViewNext} className="w-full" size="xl">
              Join
            </Button>
            <Button
              onClick={() => setActiveModal("settings")}
              variant="secondary"
              size="xl"
              className="w-full"
            >
              Settings
            </Button>
          </CardContent>
        </Card>
      </div>
      <Settings />
    </div>
  );
};

export default Title;
