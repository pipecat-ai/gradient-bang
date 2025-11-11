import { Button } from "@/components/primitives/Button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/primitives/Card";
import { Divider } from "@/components/primitives/Divider";
import { ScrollArea } from "@/components/primitives/ScrollArea";
import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { LeaderboardTable } from "../LeaderboardTable";

export const Leaderboard = () => {
  const setActiveModal = useGameStore.use.setActiveModal();
  const activeModal = useGameStore.use.activeModal?.();
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardPlayer[]>(
    []
  );

  useEffect(() => {
    if (activeModal !== "leaderboard") return;

    const fetchLeaderboard = async () => {
      const response = await fetch(
        `${
          import.meta.env.VITE_SERVER_URL
        }/leaderboard/resources?force_refresh=true`
      );
      const data = await response.json();
      setLeaderboardData(data.players);
      console.log("[LEADERBOARD] Fetched leaderboard data:", data);
    };
    fetchLeaderboard();
  }, [activeModal]);

  return (
    <Dialog.Root
      open={activeModal === "leaderboard"}
      onOpenChange={() => setActiveModal(undefined)}
    >
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {activeModal === "leaderboard" && (
            <Dialog.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="DialogOverlay bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center"
              >
                <Dialog.Title>Leaderboard</Dialog.Title>
                <Dialog.Content
                  asChild
                  forceMount
                  aria-describedby={undefined}
                  className="DialogContent max-w-3xl"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                  >
                    <Card
                      elbow={true}
                      size="default"
                      className="w-full h-full bg-black shadow-2xl"
                    >
                      <CardHeader>
                        <CardTitle className="heading-2">Leaderboard</CardTitle>
                      </CardHeader>
                      <CardContent className="h-full">
                        {leaderboardData.length > 0 ? (
                          <ScrollArea className="w-full h-full">
                            <LeaderboardTable
                              leaderboardData={leaderboardData}
                            />
                          </ScrollArea>
                        ) : (
                          <div className="text-muted-foreground text-center flex flex-col items-center justify-center h-full cross-lines-terminal-foreground/20">
                            <span className="text-sm uppercase animate-pulse bg-background/40 p-2 tracking-wider font-medium">
                              Fetching leaderboard data...
                            </span>
                          </div>
                        )}
                      </CardContent>
                      <CardFooter className="flex flex-col gap-6">
                        <Divider decoration="plus" />
                        <div className="flex flex-row gap-3 w-full">
                          <Button
                            onClick={() => setActiveModal(undefined)}
                            variant="secondary"
                            className="flex-1"
                          >
                            Close
                          </Button>
                        </div>
                      </CardFooter>
                    </Card>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
