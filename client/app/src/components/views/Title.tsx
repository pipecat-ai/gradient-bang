import { useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import TitleVideo from "@/assets/videos/title.mp4"
import { CharacterSelect } from "@/components/dialogs/CharacterSelect"
import { Leaderboard } from "@/components/dialogs/Leaderboard"
import { Settings } from "@/components/dialogs/Settings"
import { Signup } from "@/components/dialogs/Signup"
import PipecatSVG from "@/components/PipecatSVG"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader } from "@/components/primitives/Card"
import { Input } from "@/components/primitives/Input"
import { Separator } from "@/components/primitives/Separator"
import { ScrambleText } from "@/fx/ScrambleText"
import useGameStore from "@/stores/game"
import { wait } from "@/utils/animation"

export const Title = ({ onViewNext }: { onViewNext: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const setCharacterId = useGameStore.use.setCharacterId()
  const setAccessToken = useGameStore.use.setAccessToken()
  const [username, setUsername] = useState<string>("")
  const [password, setPassword] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [characters, setCharacters] = useState<
    { character_id: string; name: string }[]
  >([])
  const [state, setState] = useState<"idle" | "join">("idle")
  const [error, setError] = useState<boolean>(false)

  const handleSignIn = async () => {
    setIsLoading(true)
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1"}/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: username, password }),
        }
      )
      if (!response.ok) {
        throw new Error("Failed to sign in")
      }
      const data = await response.json()
      if (data.success && data.session.access_token) {
        setError(false)
        setCharacters(data.characters)
        setAccessToken(data.session.access_token)
        setActiveModal("character_select")
      } else {
        throw new Error("Invalid login response or no characters found")
      }
    } catch {
      setError(true)
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
                    Sign In
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
                          Incorrect username or password
                        </p>
                      </CardContent>
                    </Card>
                  )}
                  <form className="w-full flex flex-col gap-5">
                    <div className="w-full flex flex-col">
                      <Input
                        placeholder="Email"
                        className="w-full"
                        autoComplete="email"
                        type="email"
                        size="xl"
                        value={username}
                        disabled={isLoading}
                        onChange={(e) => {
                          if (error) setError(false)
                          setUsername(e.target.value)
                        }}
                      />
                      <Input
                        placeholder="Password"
                        type="password"
                        className="w-full border-t-0"
                        autoComplete="current-password"
                        size="xl"
                        value={password}
                        disabled={isLoading}
                        onChange={(e) => {
                          if (error) setError(false)
                          setPassword(e.target.value)
                        }}
                      />
                    </div>
                    <Button
                      type="submit"
                      onClick={handleSignIn}
                      isLoading={isLoading}
                      className="w-full"
                      loader="stripes"
                      size="xl"
                      disabled={!username || !password || isLoading}
                    >
                      Join
                    </Button>
                  </form>

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
      <Signup />
      <CharacterSelect
        characters={characters}
        onCharacterSelect={(characterId) => {
          setCharacterId(characterId)
          onViewNext()
        }}
      />
      <div
        className="absolute bottom-0 right-0 p-4 z-99 flex flex-row items-center gap-2 bg-background select-none"
        onClick={() => setActiveModal("signup")}
      >
        <span className="text-xs text-muted-foreground uppercase tracking-wider">
          Built by
        </span>
        <PipecatSVG className="h-[16px] text-white" />
      </div>
    </div>
  )
}

export default Title
