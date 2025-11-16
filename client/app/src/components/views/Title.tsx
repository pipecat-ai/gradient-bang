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
import { wait } from "@/utils/animation"

export const Title = ({
  onViewNext,
}: {
  onViewNext: (characterName: string) => void
}) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const [characterName, setCharacterName] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [state, setState] = useState<"idle" | "join">("idle")
  const [error, setError] = useState<boolean>(false)

  const handleLookUpCharacter = async () => {
    console.log("[TITLE] Looking up character:", characterName)
    setIsLoading(true)
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SERVER_URL}/player?character_id=${characterName}`
      )
      if (!response.ok) {
        throw new Error("Failed to look up character")
      }
      const data = await response.json()
      console.log("[TITLE] Character data:", data)
      onViewNext(characterName)
    } catch (error) {
      setError(true)
      console.error("[TITLE] Error looking up character:", error)
    } finally {
      await wait(500).then(() => setIsLoading(false))
    }
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
                  {error && (
                    <Card
                      variant="stripes"
                      size="sm"
                      className="bg-destructive/10 stripe-frame-2 stripe-frame-destructive animate-in motion-safe:fade-in-0 motion-safe:duration-1000"
                    >
                      <CardContent className="flex flex-col h-full justify-between items-center gap-1">
                        <p className="uppercase text-sm tracking-wider">
                          Character not found
                        </p>
                        <p className="text-sm text-destructive-foreground font-bold">
                          {characterName}
                        </p>
                      </CardContent>
                    </Card>
                  )}
                  <Input
                    placeholder="Enter character ID"
                    className="w-full"
                    size="xl"
                    value={characterName}
                    onChange={(e) => setCharacterName(e.target.value)}
                  />
                  <Button
                    onClick={handleLookUpCharacter}
                    isLoading={isLoading}
                    className="w-full"
                    loader="stripes"
                    size="xl"
                    disabled={!characterName || isLoading}
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
