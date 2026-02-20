import { useEffect, useMemo, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react"

import CharacterPortrait from "@/assets/images/characters/fed-cadet-1.png"
import useGameStore from "@/stores/game"

import { stripTags } from "@/utils/tts"
import type { SayTextAction } from "@/types/actions"

export const QuestCodecOverlay = () => {
  const incomingCodec = useGameStore((state) => state.notifications.incomingCodec)
  const getActiveCodec = useGameStore.use.getActiveCodec()
  const setNotifications = useGameStore.use.setNotifications()
  const dispatchAction = useGameStore.use.dispatchAction()

  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)

  const codec = open ? getActiveCodec() : null
  const pages = useMemo(() => codec?.pages ?? [], [codec?.pages])
  const totalPages = pages.length
  const isLastPage = page >= totalPages - 1

  useEffect(() => {
    if (incomingCodec && !open) {
      codecOverlayApi.open = () => {
        setPage(0)
        setOpen(true)
      }
    } else {
      codecOverlayApi.open = null
    }
    return () => {
      codecOverlayApi.open = null
    }
  }, [incomingCodec, open])

  // Read back the current page text via TTS whenever the page changes
  useEffect(() => {
    if (open && pages[page]) {
      dispatchAction({
        type: "say-text",
        payload: {
          voice_id: "6ccbfb76-1fc6-48f7-b71d-91ac6298247b",
          text: pages[page],
        },
      } as SayTextAction)
    }
  }, [open, page, pages, dispatchAction])

  function dismiss() {
    setOpen(false)
    setPage(0)
    setNotifications({ incomingCodec: false })
    dispatchAction({ type: "say-text-dismiss" })
  }

  function handleNext(e: React.MouseEvent) {
    e.stopPropagation()
    if (isLastPage) {
      dismiss()
    } else {
      setPage((p) => p + 1)
    }
  }

  function handlePrev(e: React.MouseEvent) {
    e.stopPropagation()
    if (page > 0) setPage((p) => p - 1)
  }

  if (!open || !codec) return null

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="codec-overlay"
          className="fixed inset-0 z-(--z-toasts) flex items-center justify-center pointer-events-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
          />

          {/* Content */}
          <div className="relative z-10 flex flex-row items-end gap-0 max-w-3xl">
            {/* Portrait — full size, anchored to bottom */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="shrink-0"
            >
              <img
                src={CharacterPortrait}
                alt={codec.giver}
                className="h-72 w-auto object-contain drop-shadow-lg"
              />
            </motion.div>

            {/* Dialog panel */}
            <div className="flex flex-col gap-5 pb-4 w-105">
              {/* Header */}
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.15 }}
                className="flex flex-row gap-5 items-center"
              >
                <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-20" />
                <span className="text-xs uppercase tracking-[0.3em] font-bold text-terminal whitespace-nowrap">
                  Incoming Codec
                </span>
                <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-20" />
              </motion.div>

              {/* Giver name */}
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.25 }}
                className="text-[10px] uppercase tracking-[0.2em] text-terminal font-bold"
              >
                {codec.giver}
              </motion.span>

              {/* Page text */}
              <div className="relative min-h-20">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={page}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.3 }}
                    className="text-sm text-foreground leading-relaxed"
                  >
                    {stripTags(pages[page])}
                  </motion.p>
                </AnimatePresence>
              </div>

              {/* Navigation */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.35 }}
                className="flex items-center gap-4"
              >
                {totalPages > 1 && (
                  <button
                    onClick={handlePrev}
                    disabled={page === 0}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                  >
                    <CaretLeftIcon size={16} weight="bold" />
                  </button>
                )}

                <button
                  onClick={handleNext}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs uppercase tracking-wider font-bold text-terminal hover:brightness-125 transition-[filter] cursor-pointer"
                >
                  {isLastPage ? "Dismiss" : "Continue"}
                  {!isLastPage && <CaretRightIcon size={12} weight="bold" />}
                </button>

                {totalPages > 1 && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {page + 1}/{totalPages}
                  </span>
                )}
              </motion.div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// Simple API for the badge to open the overlay without prop drilling
export const codecOverlayApi: { open: (() => void) | null } = { open: null }
