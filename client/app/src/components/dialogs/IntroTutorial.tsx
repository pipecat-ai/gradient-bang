import { useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import RadialGrad from "@/assets/images/radial-grad-md.png"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import { InfoIconMD } from "@/components/svg/InfoIconMD"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

const TUTORIAL_VIDEO_URL =
  "https://api.gradient-bang.com/storage/v1/object/public/GB%20Public/tutorial.mp4"

export const IntroTutorial = ({ onContinue }: { onContinue: () => void }) => {
  const activeModal = useGameStore.use.activeModal?.()
  const isOpen = activeModal?.modal === "intro_tutorial"
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hovered, setHovered] = useState(false)
  const [showConfirmTutorial, setShowConfirmTutorial] = useState(false)

  useEffect(() => {
    if (isOpen) {
      useAudioStore.getState().fadeOut("theme", { duration: 1500 })
    }
  }, [isOpen])

  const handleVideoEnded = () => {
    setShowConfirmTutorial(true)
  }

  const handleContinue = (_bypassTutorial: boolean = false) => {
    // Note: we do not hide the modal here to prevent FOUS

    // Tutorial is not ready yet — always bypass regardless of user choice
    useGameStore.getState().setBypassTutorial(true)

    // Continue to connect
    onContinue()
  }

  return (
    <BaseDialog
      modalName="intro_tutorial"
      title="Welcome"
      size="full"
      overlayVariant="dots"
      noPadding
      dismissOnClickOutside={false}
      showCloseButton={false}
      contentClassName="h-screen z-[100]"
      overlayClassName="z-[100]"
    >
      <div
        className="relative w-full h-full flex items-center justify-center bg-background"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <AnimatePresence>
          {showConfirmTutorial && (
            <motion.div
              key="confirm-tutorial"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            >
              <div className="dialog-dots opacity-20 absolute inset-0 z-0" />

              <div className="max-w-2xl relative">
                <img
                  src={RadialGrad}
                  alt=""
                  className="absolute -top-32 left-1/2 -translate-x-1/2 opacity-40 z-10 select-none"
                />
                <div className="absolute -top-10 left-1/2 -translate-x-1/2 size-20 flex items-center justify-center border border-accent-foreground shadow-long shadow-black/40 bg-background z-50">
                  <InfoIconMD className="text-terminal size-8" />
                </div>

                <Card className="bg-background/50 elbow z-20">
                  <CardContent className="flex flex-col gap-ui-md relative pt-10">
                    <h2 className="text-white text-base uppercase font-bold">
                      Start new player tutorial?
                    </h2>
                    <p className="text-white text-sm text-pretty mb-ui-sm leading-relaxed">
                      This tutorial will guide you through the basics of the gameplay, UI and voice
                      agent commands. Recommended for first time players.
                    </p>
                    <Divider variant="dashed" className="h-4 text-accent" />
                  </CardContent>
                  <CardFooter className="flex flex-row gap-ui-sm justify-end">
                    <Button variant="ghost" size="lg" onClick={() => handleContinue(true)}>
                      No, skip tutorial
                    </Button>
                    <Button size="lg" onClick={() => handleContinue()}>
                      Yes (recommended)
                    </Button>
                  </CardFooter>
                </Card>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {!showConfirmTutorial && (
          <>
            <video
              ref={videoRef}
              src={TUTORIAL_VIDEO_URL}
              className="max-w-480 max-h-270 w-full h-full object-contain"
              autoPlay
              playsInline
              preload="auto"
              controls={hovered}
              onEnded={handleVideoEnded}
            />
            <div className="fixed top-ui-md right-ui-md z-10">
              <Button variant="ghost" size="sm" onClick={handleVideoEnded}>
                Skip
              </Button>
            </div>
          </>
        )}
      </div>
    </BaseDialog>
  )
}
