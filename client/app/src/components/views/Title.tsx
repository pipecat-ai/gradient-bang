import { useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react"
import { cva } from "class-variance-authority"

import TitleVideo from "@/assets/videos/title.mp4"
import { CharacterSelectDialog } from "@/components/dialogs/CharacterSelect"
import { IntroTutorial } from "@/components/dialogs/IntroTutorial"
import { Leaderboard } from "@/components/dialogs/Leaderboard"
import { Settings } from "@/components/dialogs/Settings"
import PipecatSVG from "@/components/PipecatSVG"
import { Badge, BadgeTitle } from "@/components/primitives/Badge"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader } from "@/components/primitives/Card"
import { Input } from "@/components/primitives/Input"
import { Separator } from "@/components/primitives/Separator"
import { ScrambleText } from "@/fx/ScrambleText"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { wait } from "@/utils/animation"
import {
  buildServerFunctionUrl,
  getLoginScreenServerBadge,
  parsePublicServerStatus,
  type LoginScreenServerState,
} from "@/utils/serverStatus"

const SERVER_STATUS_REFRESH_MS = 30_000

const serverStatusBadgeStyles = cva("mx-auto min-w-[14rem] justify-center text-center", {
  variants: {
    state: {
      checking: "bg-muted/60 border-border text-subtle-foreground bracket-muted-foreground",
      online: "bg-success-background border-success text-success-foreground bracket-success",
      maintenance: "bg-warning-background border-warning text-warning-foreground bracket-warning",
      offline:
        "bg-destructive-background/60 border-destructive/60 text-destructive bracket-destructive",
    },
  },
  defaultVariants: {
    state: "checking",
  },
})

const serverStatusDotStyles = cva("size-2 rounded-full", {
  variants: {
    state: {
      checking: "bg-subtle-foreground animate-pulse",
      online: "bg-success animate-pulse",
      maintenance: "bg-warning animate-pulse",
      offline: "bg-destructive",
    },
  },
  defaultVariants: {
    state: "checking",
  },
})

export const Title = ({ onViewNext }: { onViewNext: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const setCharacterId = useGameStore.use.setCharacterId()
  const setAccessToken = useGameStore.use.setAccessToken()
  const setCharacters = useGameStore.use.setCharacters()
  const [username, setUsername] = useState<string>("")
  const [password, setPassword] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [state, setState] = useState<"idle" | "join">("idle")
  const [error, setError] = useState<string | null>(null)
  const [isMusicPlaying, setIsMusicPlaying] = useState<boolean>(false)
  const [hasInteractedWithMusic, setHasInteractedWithMusic] = useState<boolean>(false)
  const [serverStatus, setServerStatus] = useState<{
    state: LoginScreenServerState
    message: string
  }>({
    state: "checking",
    message: "",
  })
  const titleVideoRef = useRef<HTMLVideoElement>(null)
  const serverStatusBadge = getLoginScreenServerBadge(serverStatus.state, serverStatus.message)

  useEffect(() => {
    let disposed = false
    let activeController: AbortController | null = null

    const refreshServerStatus = async () => {
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller

      try {
        const response = await fetch(
          buildServerFunctionUrl("server_status", import.meta.env.VITE_SERVER_URL),
          {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
            signal: controller.signal,
          }
        )
        const data = await response.json().catch(() => null)

        if (!response.ok) {
          throw new Error(
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : "Unable to reach the public status endpoint."
          )
        }

        const parsed = parsePublicServerStatus(data)
        if (!parsed) {
          throw new Error("Unexpected response from the public status endpoint.")
        }

        if (!disposed) {
          setServerStatus(parsed)
        }
      } catch (err) {
        if (controller.signal.aborted || disposed) {
          return
        }

        setServerStatus({
          state: "offline",
          message:
            err instanceof Error ? err.message : "Unable to reach the public status endpoint.",
        })
      }
    }

    void refreshServerStatus()
    const intervalId = window.setInterval(() => {
      void refreshServerStatus()
    }, SERVER_STATUS_REFRESH_MS)

    return () => {
      disposed = true
      activeController?.abort()
      window.clearInterval(intervalId)
    }
  }, [])

  const startMusic = () => {
    setIsMusicPlaying(true)
    setHasInteractedWithMusic(true)
    useAudioStore.getState().fadeIn("theme", { volume: 0.2, duration: 5000 })
  }

  const stopMusic = () => {
    setIsMusicPlaying(false)
    useAudioStore.getState().fadeOut("theme", { duration: 2000 })
  }

  const handleSignIn = async () => {
    setIsLoading(true)
    try {
      const response = await fetch(buildServerFunctionUrl("login", import.meta.env.VITE_SERVER_URL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: username, password }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || "Failed to sign in")
      }
      if (data?.success && data.session?.access_token) {
        setError(null)
        setCharacters(data.characters)
        setAccessToken(data.session.access_token)
        setActiveModal("character_select")
      } else {
        throw new Error(data?.error || "Invalid login response or no characters found")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect username or password")
    } finally {
      await wait(500).then(() => setIsLoading(false))
    }
  }

  const handleCharacterSelect = (characterId: string, isNewCharacter: boolean) => {
    console.debug(
      "%cCharacter selected, proceeding to next view",
      "color: blue; font-weight: bold;",
      { characterId, isNewCharacter }
    )
    setCharacterId(characterId)
    if (isNewCharacter) {
      titleVideoRef.current?.pause()
      setActiveModal("intro_tutorial")
    } else {
      onViewNext()
    }
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div className="absolute inset-0">
        <video
          ref={titleVideoRef}
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
            <h1 className="text-white text-3xl font-bold uppercase text-center">
              <ScrambleText>Gradient Bang</ScrambleText>
            </h1>
            <div className="mt-4 flex flex-col items-center gap-2">
              <Badge
                border="bracket"
                size="sm"
                aria-label={serverStatusBadge.label}
                className={serverStatusBadgeStyles({ state: serverStatusBadge.state })}
              >
                <span className={serverStatusDotStyles({ state: serverStatusBadge.state })} />
                <BadgeTitle>{serverStatusBadge.label}</BadgeTitle>
              </Badge>
              {serverStatusBadge.detail && (
                <p className="max-w-sm text-center text-xs text-subtle-foreground">
                  {serverStatusBadge.detail}
                </p>
              )}
            </div>
          </CardHeader>
          <Separator />
          <CardContent className="flex flex-col items-center justify-center gap-5">
            <AnimatePresence mode="wait">
              {state === "idle" && (
                <motion.div
                  key="idle"
                  initial={{ x: -50, opacity: 0 }}
                  animate={{
                    x: 0,
                    opacity: 1,
                    transition: { duration: 0.2, ease: "easeInOut" },
                  }}
                  exit={{
                    x: -50,
                    opacity: 0,
                    transition: { duration: 0.2, ease: "easeInOut" },
                  }}
                  className="w-full flex flex-col gap-5"
                >
                  <Button
                    onClick={() => {
                      setState("join")
                      if (!isMusicPlaying) startMusic()
                    }}
                    className="w-full"
                    size="xl"
                  >
                    Sign In
                  </Button>
                  <a
                    href="https://www.gradient-bang.com/join"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="self-center w-fit text-center"
                  >
                    <p className="text-xs uppercase text-subtle-foreground hover:text-foreground">
                      Need an account? Sign up here!
                    </p>
                  </a>
                  <Separator />
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
                  animate={{
                    x: 0,
                    opacity: 1,
                    transition: { duration: 0.2, ease: "easeInOut" },
                  }}
                  exit={{
                    x: 50,
                    opacity: 0,
                    transition: { duration: 0.2, ease: "easeInOut" },
                  }}
                  className="w-full flex flex-col gap-5"
                >
                  {error && (
                    <Card
                      variant="stripes"
                      size="sm"
                      className="bg-destructive/10 stripe-frame-2 stripe-frame-destructive animate-in motion-safe:fade-in-0 motion-safe:duration-1000"
                    >
                      <CardContent className="flex flex-col h-full justify-between items-center gap-1">
                        <p className="uppercase text-sm tracking-wider text-center">{error}</p>
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
                          if (error) setError(null)
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
                          if (error) setError(null)
                          setPassword(e.target.value)
                        }}
                      />
                    </div>
                    <a
                      href="https://www.gradient-bang.com/forgot-password"
                      target="_blank"
                      rel="noopener noreferrer w-fit"
                    >
                      <p className="text-xs uppercase text-subtle-foreground hover:text-foreground w-fit">
                        Forgot password?
                      </p>
                    </a>
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
                    onClick={() => {
                      setState("idle")
                      stopMusic()
                    }}
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
            {state === "join" && hasInteractedWithMusic ?
              <Button
                variant="secondary"
                size="sm"
                onClick={isMusicPlaying ? stopMusic : startMusic}
              >
                {isMusicPlaying ?
                  <SpeakerSlashIcon />
                : <SpeakerHighIcon />}
                {isMusicPlaying ? "Stop Music" : "Play Music"}
              </Button>
            : <p className="text-muted-foreground text-sm font-bold uppercase tracking-wider leading-tight">
                Dev Build {import.meta.env.VITE_APP_VERSION}
              </p>
            }
            <div className="bg-dotted-sm bg-dotted-white/30 self-stretch flex-1" />
          </div>
        </Card>
      </div>
      <Settings />
      <Leaderboard />
      <CharacterSelectDialog onCharacterSelect={handleCharacterSelect} />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 p-4 z-99 flex flex-row items-center gap-2 bg-background select-none">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">Built by</span>
        <PipecatSVG className="h-[16px] text-white" />
      </div>

      {/** Intro Tutorial Video Modal */}
      <IntroTutorial onContinue={onViewNext} />
    </div>
  )
}

export default Title
