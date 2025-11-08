import { Button } from "@/components/primitives/Button";
import { Card, CardContent, CardHeader } from "@/components/primitives/Card";
import { Separator } from "@/components/primitives/Separator";
import { Settings } from "@/dialogs/Settings";
import useGameStore from "@/stores/game";

import TitleVideo from "@assets/videos/title.mp4";
import { ScrambleText } from "@fx/ScrambleText";

export const Title = ({ onViewNext }: { onViewNext: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal();

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div className="absolute inset-0">
        <video
          src={TitleVideo}
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
        <Card
          elbow={true}
          variant="secondary"
          size="xl"
          className="min-w-lg border border-border pb-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-1000 shadow-long"
        >
          <CardHeader className="block">
            <h1 className="text-white text-3xl font-bold uppercase">
              <ScrambleText>Gradient Bang Dev Build</ScrambleText>
            </h1>
          </CardHeader>
          <Separator />
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
          <div className="flex flex-row gap-5 text-center justify-center items-center px-6 border-t border-border pt-5">
            <div className="bg-dotted-sm bg-dotted-white/30 self-stretch flex-1" />
            <p className="text-muted-foreground text-sm font-bold uppercase tracking-wider leading-tight">
              Dev Build {import.meta.env.VITE_APP_VERSION}
            </p>
            <div className="bg-dotted-sm bg-dotted-white/30 self-stretch flex-1" />
          </div>
        </Card>
      </div>
      <Settings />
    </div>
  );
};

export default Title;
