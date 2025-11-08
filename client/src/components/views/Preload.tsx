import { Progress } from "@/components/primitives/Progress";
import { useAssetPreloader } from "@/hooks/useAssetPreloader";
import { wait } from "@/utils/animation";
import { useEffect } from "react";

import { cn } from "@/utils/tailwind";
import Splash from "@assets/images/splash-1.png";
import PlanetLoader from "@assets/videos/planet-loader.mp4";
import { Badge, BadgeTitle } from "../primitives/Badge";
import { Card, CardContent } from "../primitives/Card";
import { DotDivider } from "../primitives/DotDivider";
import { Separator } from "../primitives/Separator";

interface PreloadProps {
  onComplete: () => void;
}

export const Preload = ({ onComplete }: PreloadProps) => {
  const { preloadAll, progress, isComplete } = useAssetPreloader();

  useEffect(() => {
    preloadAll();
  }, [preloadAll]);

  useEffect(() => {
    if (isComplete) {
      wait(1000).then(() => {
        onComplete();
      });
    }
  }, [isComplete, onComplete]);

  return (
    <div className="relative h-screen w-screen overflow-hidden flex flex-col justify-center bg-black">
      <main className="relative h-full w-full flex items-center justify-center">
        <img
          src={Splash}
          alt="Splash"
          className="absolute inset-0 w-full h-full object-contain z-1 pointer-events-none object-bottom"
        />

        <div className="relative w-sm z-2 shadow-long">
          <Card className="bg-black">
            <CardContent className="flex flex-col gap-4">
              <video
                src={PlanetLoader}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
                className="w-[120px] h-[120px] object-contain mx-auto"
              />
              <Separator variant="dashed" />
              <span className="heading-2 animate-pulse font-light text-center">
                {progress.percentage >= 100
                  ? "Download complete"
                  : "Downloading game assets"}
              </span>
            </CardContent>
          </Card>

          {/* Error State */}
          {progress.phase === "error" && (
            <div className="mt-4 p-4 bg-destructive-background bg-opacity-20 border border-destructive rounded text-destructive text-sm">
              {progress.message}
            </div>
          )}
        </div>
      </main>
      <footer className="relative w-full p-ui-md bg-stripes-sm bg-stripes-border/80 bg-stripes-overlay-muted border-t border-border">
        <div className="flex flex-row gap-ui-md items-center justify-between">
          <Progress
            value={progress.percentage}
            color="fuel"
            className="h-[20px] w-full stripe-bar stripe-bar-fuel/20 stripe-bar-20 stripe-bar-animate-1"
          />

          <Badge border="bracket" size="sm">
            <BadgeTitle>
              {progress.loaded} <span className="opacity-30">/</span>{" "}
              {progress.total}
            </BadgeTitle>

            <DotDivider />

            <BadgeTitle
              className={cn(
                progress.percentage >= 100 ? "text-fuel animate-pulse" : "  "
              )}
            >
              {progress.percentage}%
            </BadgeTitle>
          </Badge>
        </div>
      </footer>
    </div>
  );
};
