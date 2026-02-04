import { useEffect } from "react"

import { AnimatePresence, motion } from "motion/react"
import { Dialog } from "radix-ui"
import { MedalIcon } from "@phosphor-icons/react"

import { ModalCloseButton } from "@/components/ModalCloseButton"
import { LeaderboardPanel } from "@/components/panels/LeaderboardPanel"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import useGameStore from "@/stores/game"

const LEADERBOARD_URL =
  (import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1") +
  (import.meta.env.VITE_SERVER_LEADERBOARD_ENDPOINT ?? "/leaderboard_resources")

export const Leaderboard = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()

  useEffect(() => {
    if (activeModal !== "leaderboard") return

    const fetchLeaderboard = async () => {
      console.debug("[LEADERBOARD] Fetching leaderboard data...")
      const response = await fetch(`${LEADERBOARD_URL}`)
      const data = await response.json()
      useGameStore.getState().setLeaderboardData(data)
      console.debug("[LEADERBOARD] Fetched leaderboard data:", data)
    }
    const leaderboardLastUpdated = useGameStore.getState().leaderboard_last_updated
    if (
      leaderboardLastUpdated &&
      new Date(leaderboardLastUpdated).getTime() + 1000 * 60 * 5 > Date.now()
    ) {
      console.debug("[LEADERBOARD] Leaderboard data is up to date, skipping fetch")
      return
    }
    fetchLeaderboard()
  }, [activeModal])

  return (
    <Dialog.Root
      open={activeModal === "leaderboard"}
      onOpenChange={() => setActiveModal(undefined)}
    >
      <Dialog.Portal>
        <AnimatePresence>
          {activeModal === "leaderboard" && (
            <Dialog.Overlay>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="DialogOverlay bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm text-subtle dialog-dots"
              >
                <div className="hidden">
                  <Dialog.Title className="flex flex-row items-center gap-2">
                    Leaderboard
                  </Dialog.Title>
                </div>

                <Dialog.Content
                  asChild
                  aria-describedby={undefined}
                  className="DialogContent max-w-3xl"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                  >
                    <ModalCloseButton handleClose={() => setActiveModal(undefined)} />

                    <Card elbow={true} size="default" className="w-full h-full bg-black shadow-2xl">
                      <CardHeader>
                        <CardTitle className="heading-2 flex flex-row items-center gap-2">
                          <MedalIcon size={24} weight="bold" />
                          Leaderboard
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="h-full min-h-0">
                        <LeaderboardPanel />
                      </CardContent>
                      <CardFooter className="flex flex-col gap-6">
                        <Divider decoration="plus" color="accent" />
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
  )
}
