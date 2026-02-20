import { useEffect, useRef } from "react"

import { AnimatePresence, motion } from "motion/react"
import { Dialog } from "radix-ui"

import { ModalCloseButton } from "@/components/ModalCloseButton"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const OVERLAY_ANIMATION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.3, ease: "easeInOut" as const },
}

const CONTENT_ANIMATION = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.3, ease: "easeInOut" as const },
}

const SIZE_MAP: Record<string, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-xl",
  xl: "max-w-2xl",
  "2xl": "max-w-3xl",
  full: "w-screen",
}

const OVERLAY_VARIANTS: Record<string, string> = {
  dots: "dialog-dots",
  dotted: "bg-dotted-lg bg-dotted-white/10 bg-center",
  none: "",
}

export interface BaseDialogProps {
  modalName: string
  title: string
  children: React.ReactNode
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "full" | string
  overlayVariant?: "dots" | "dotted" | "none"
  contentClassName?: string
  noPadding?: boolean
  playOpenSound?: boolean
  dismissOnClickOutside?: boolean
  onClose?: () => void
  onOpenAutoFocus?: (e: Event) => void
  onCloseAutoFocus?: (e: Event) => void
}

export const BaseDialog = ({
  modalName,
  title,
  children,
  size = "lg",
  overlayVariant = "dots",
  contentClassName,
  noPadding = false,
  playOpenSound = true,
  dismissOnClickOutside = true,
  onClose,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: BaseDialogProps) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const playSound = useAudioStore.use.playSound()
  const wasOpenRef = useRef(false)

  const isOpen = activeModal === modalName

  // Play sound when modal opens
  useEffect(() => {
    if (isOpen && !wasOpenRef.current && playOpenSound) {
      playSound("chime4")
    }
    wasOpenRef.current = isOpen
  }, [isOpen, playOpenSound, playSound])

  const handleClose = () => {
    onClose?.()
    setActiveModal(undefined)
  }

  const sizeClass = SIZE_MAP[size] || size
  const overlayVariantClass = OVERLAY_VARIANTS[overlayVariant] || ""

  return (
    <Dialog.Root open={isOpen} onOpenChange={() => handleClose()}>
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {isOpen && (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  {...OVERLAY_ANIMATION}
                  className={cn(
                    "DialogOverlay z-[90] bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm text-subtle",
                    overlayVariantClass
                  )}
                />
              </Dialog.Overlay>
              <motion.div {...CONTENT_ANIMATION} className="fixed top-0 right-0 z-91">
                <ModalCloseButton handleClose={handleClose} />
              </motion.div>
              <Dialog.Content
                asChild
                forceMount
                aria-describedby={undefined}
                className={cn(
                  "DialogContent z-90",
                  sizeClass,
                  noPadding && "DialogContent-NoPadding",
                  contentClassName
                )}
                onPointerDownOutside={
                  dismissOnClickOutside
                    ? undefined
                    : (e) => {
                        // Allow the close button to still work
                        const target = e.detail.originalEvent.target as HTMLElement
                        if (!target.closest("[data-modal-close]")) {
                          e.preventDefault()
                        }
                      }
                }
                onOpenAutoFocus={onOpenAutoFocus}
                onCloseAutoFocus={onCloseAutoFocus}
              >
                <motion.div {...CONTENT_ANIMATION}>
                  <Dialog.Title className="sr-only">{title}</Dialog.Title>
                  {children}
                </motion.div>
              </Dialog.Content>
            </>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
