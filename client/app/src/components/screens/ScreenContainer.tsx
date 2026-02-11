import { useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { Dialog } from "radix-ui"
import { XIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Button } from "../primitives/Button"
import { ShipDetails } from "./ShipDetails"

const variants = {
  enter: {
    opacity: 1,
    transition: { delay: 0.4, duration: 0.3, easing: "ease-in-out" },
  },
  exit: { opacity: 0, transition: { duration: 0.2, easing: "ease-in-out" } },
}

export const ScreenBase = ({ children, full }: { children: React.ReactNode; full?: boolean }) => {
  return (
    <div
      id="screen-container"
      className={cn("screen pointer-events-auto", full ? "w-full h-full" : "")}
    >
      {children}
    </div>
  )
}

export const ScreenContainer = () => {
  const activeScreen = useGameStore.use.activeScreen?.()
  const overlayScreen = activeScreen?.screen === "map" ? undefined : activeScreen
  const prevActiveScreenRef = useRef<{ screen: UIScreen; data?: unknown } | undefined>(
    overlayScreen
  )
  const diamondFXInstance = useGameStore.use.diamondFXInstance?.()
  const setActiveScreen = useGameStore.use.setActiveScreen?.()

  const [closingScreen, setClosingScreen] = useState<
    { screen: UIScreen; data?: unknown } | undefined
  >(undefined)

  const isClosing = closingScreen !== undefined
  const displayedScreen = closingScreen ?? overlayScreen

  useEffect(() => {
    // Screen closed
    if (prevActiveScreenRef.current?.screen && !overlayScreen?.screen) {
      diamondFXInstance?.clear(true)
    }
    // Screen opened (or changed)
    if (overlayScreen?.screen && prevActiveScreenRef.current?.screen !== overlayScreen.screen) {
      // Fire your handler here
      diamondFXInstance?.start("screen-container", false, true, {
        half: true,
      })
    }
    prevActiveScreenRef.current = overlayScreen
  }, [overlayScreen, diamondFXInstance])

  const handleClose = () => {
    if (!overlayScreen) return
    setClosingScreen(overlayScreen)
    setActiveScreen(undefined)
  }

  const handleExitComplete = () => {
    setClosingScreen(undefined)
  }

  const isOpen = overlayScreen?.screen !== undefined || isClosing

  const dottedCX =
    "DialogOverlay bg-muted/40 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm text-subtle dialog-dots"
  const noDottedCX =
    "DialogOverlay motion-safe:bg-muted/40 motion-safe:backdrop-blur-xs text-subtle"

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn("z-20", overlayScreen?.screen === "map" ? noDottedCX : dottedCX)}
        ></Dialog.Overlay>
        <Dialog.Content
          aria-describedby={undefined}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              handleClose()
            }
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => import.meta.env.DEV && e.preventDefault()}
          className="DialogContent DialogContent-NoPadding z-20 w-[calc(100vw-var(--spacing-ui-2xl)*2)] h-[calc(100dvh-var(--spacing-ui-2xl)*2)] pointer-events-none"
        >
          <Dialog.Close asChild>
            <Button
              variant="secondary"
              size="icon-lg"
              onClick={handleClose}
              className="fixed top-ui-md right-ui-md z-50"
            >
              <XIcon weight="bold" className="size-4" />
            </Button>
          </Dialog.Close>
          <div className="hidden">
            <Dialog.Title>{overlayScreen?.screen}</Dialog.Title>
          </div>
          <AnimatePresence mode="wait" onExitComplete={handleExitComplete}>
            {!isClosing && displayedScreen?.screen && (
              <motion.div
                key={displayedScreen.screen}
                variants={variants}
                initial="exit"
                animate="enter"
                exit="exit"
                className={displayedScreen.screen === "map" ? "w-full h-full" : ""}
              >
                {displayedScreen.screen === "ship-details" && (
                  <ScreenBase>
                    <ShipDetails ship={displayedScreen.data as ShipDefinition} />
                  </ScreenBase>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
