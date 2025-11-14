import { useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import TitleVideo from "@/assets/videos/title.mp4"
import { Leaderboard } from "@/components/dialogs/Leaderboard"
import { Settings } from "@/components/dialogs/Settings"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader } from "@/components/primitives/Card"
import { Input } from "@/components/primitives/Input"
import { Separator } from "@/components/primitives/Separator"
import { ScrambleText } from "@/fx/ScrambleText"
import useGameStore from "@/stores/game"

export const Title = ({
  onViewNext,
}: {
  onViewNext: (characterName: string) => void
}) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  //const setCharacterId = useGameStore.use.setCharacterId()
  const [characterName, setCharacterName] = useState<string>("")
  const [state, setState] = useState<"idle" | "join">("idle")

  
  const handleViewNext = () => {
    console.log("[TITLE] Joining with name:", characterName)

    onViewNext(characterName)
  }

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
            <AnimatePresence mode="wait">
              {state === "idle" && (
                <motion.div
                  key="idle"
                  initial={{ x: -50, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -50, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeInOut" }}
                  className="w-full flex flex-col gap-5"
                >
                  <Button
                    onClick={() => setState("join")}
                    className="w-full"
                    size="xl"
                  >
                    Start
                  </Button>
                  <Button
                    onClick={() => setActiveModal("leaderboard")}
                    variant="secondary"
                    size="xl"
                    className="w-full"
                  >
                    Leaderboard
                  </Button>
                  <Button
                    onClick={() => setActiveModal("settings")}
                    variant="secondary"
                    size="xl"
                    className="w-full"
                  >
                    Settings
                  </Button>
                </motion.div>
              )}
              {state === "join" && (
                <motion.div
                  key="join"
                  initial={{ x: 50, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: 50, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeInOut" }}
                  className="w-full flex flex-col gap-5"
                >
                  <Input
                    placeholder="Enter character name"
                    className="w-full"
                    size="xl"
                    value={characterName}
                    onChange={(e) => setCharacterName(e.target.value.trim())}
                  />
                  <Button
                    onClick={handleViewNext}
                    className="w-full"
                    size="xl"
                    disabled={!characterName}
                  >
                    Connect
                  </Button>
                  <Separator />
                  <Button
                    variant="secondary"
                    onClick={() => setState("idle")}
                    className="w-full"
                    size="xl"
                  >
                    Back
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
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
      <Leaderboard />
    </div>
  )
}

export default Title
