import { Button } from "@/components/primitives/Button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/primitives/Card";
import { Divider } from "@/components/primitives/Divider";
import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";

const LeaderboardPlayerRow = ({ player }: { player: LeaderboardPlayer }) => {
  return (
    <tr>
      <td className="py-1">{player.name}</td>
      <td className="py-1">{player.rank}</td>
      <td className="py-1">
        {player.bank_credits +
          player.ship_credits +
          player.ship_trade_in_value +
          player.garrison_fighter_value}
      </td>
      <td className="py-1">{player.sectors_visited}</td>
      <td className="py-1">{player.exploration_percent}%</td>
      <td className="py-1">{player.total_resources}</td>
    </tr>
  );
};

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
                  className="DialogContent max-w-xl"
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
                      className="w-full h-full max-h-max bg-black shadow-2xl"
                    >
                      <CardHeader>
                        <CardTitle className="heading-2">Leaderboard</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <table className="w-full text-xs">
                          <thead className="text-left bg-background border-b border-border">
                            <tr>
                              <th className="py-1 uppercase">Name</th>
                              <th className="py-1 uppercase">Rank</th>
                              <th className="py-1 uppercase">Net worth</th>
                              <th className="py-1 uppercase">
                                Sectors visited
                              </th>
                              <th className="py-1 uppercase">
                                Exploration percent
                              </th>
                              <th className="py-1 uppercase">
                                Total resources
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {leaderboardData.map(
                              (player: LeaderboardPlayer) => (
                                <LeaderboardPlayerRow
                                  key={player.character_id}
                                  player={player}
                                />
                              )
                            )}
                          </tbody>
                        </table>
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
