import { useEffect, useMemo, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { ArrowRightIcon, CaretLeftIcon, WaveSineIcon } from "@phosphor-icons/react"

import CharacterPortrait from "@/assets/images/characters/fed-cadet-1.png"
import { DottedTitle } from "@/components/DottedTitle"
import { Button } from "@/components/primitives/Button"
import { Card } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"
import { stripTags } from "@/utils/tts"

import { BaseDialog } from "./BaseDialog"

import type { SayTextAction } from "@/types/actions"

export const QuestCodec = () => {
  const getActiveCodec = useGameStore.use.getActiveCodec()
  const setNotifications = useGameStore.use.setNotifications()
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const dispatchAction = useGameStore.use.dispatchAction()

  const isOpen = activeModal === "quest_codec"

  const [page, setPage] = useState(0)

  const codec = isOpen ? getActiveCodec() : null
  const pages = useMemo(() => codec?.pages ?? [], [codec?.pages])
  const totalPages = pages.length
  const isLastPage = page >= totalPages - 1

  // Read back the current page text via TTS whenever the page changes
  useEffect(() => {
    if (isOpen && pages[page]) {
      dispatchAction({
        type: "say-text",
        payload: {
          voice_id: "6ccbfb76-1fc6-48f7-b71d-91ac6298247b",
          text: pages[page],
        },
      } as SayTextAction)
    }
  }, [isOpen, page, pages, dispatchAction])

  function dismiss() {
    setActiveModal(undefined)
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

  return (
    <BaseDialog
      modalName="quest_codec"
      title="Incoming Codec"
      size="4xl"
      dismissOnClickOutside={false}
      onClose={dismiss}
    >
      {codec && (
        <div className="relative flex flex-row items-end gap-0 w-3xl">
          {/* Portrait — full size, anchored to bottom */}
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="shrink-0 absolute left-0 bottom-0 z-10"
          >
            <img
              src={CharacterPortrait}
              alt={codec?.giver}
              className="h-80 w-auto object-contain z-20"
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="absolute left-0 w-fit bg-background text-foreground leading-none px-2.5 pl-2 py-1.5 gap-2 outline-1 outline-terminal border-l-7 border-terminal/30 font-medium uppercase text-xs pointer-events-none bottom-0 translate-y-1/2 z-30 flex flex-row items-center"
          >
            <WaveSineIcon size={16} weight="bold" className="size-3.5 text-terminal" />{" "}
            {codec?.giver}
          </motion.div>

          {/* Dialog panel */}
          <div className="w-full shadow-xlong">
            <Card className="px-ui-md pl-70 mask-[linear-gradient(to_right,transparent_20%,black_calc(var(--spacing)*70))] elbow elbow-offset-1 gap-ui-md">
              {/* Header */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.5 }}
              >
                <DottedTitle title="Incoming Transmission" className="w-full animate-pulse" />
              </motion.div>

              {/* Page text */}
              <div className="relative min-h-[6lh] text-sm">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={page}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.3 }}
                    className="text-sm text-foreground leading-relaxed text-pretty"
                  >
                    {pages[page] ? stripTags(pages[page]) : ""}
                  </motion.p>
                </AnimatePresence>
              </div>

              {/* Navigation */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.35 }}
                className="flex gap-4 flex-1 items-center justify-between"
              >
                <div className="flex flex-row gap-2 items-center">
                  {totalPages > 1 && (
                    <span className="text-xs text-accent-foreground tabular-nums tracking-widest">
                      {page + 1}/{totalPages}
                    </span>
                  )}
                </div>

                <div className="flex flex-row gap-3 items-center">
                  {totalPages > 1 && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={handlePrev}
                      disabled={page === 0}
                      className="text-subtle disabled:opacity-0 transition-opacity cursor-pointer disabled:cursor-default"
                    >
                      <CaretLeftIcon /> Previous
                    </Button>
                  )}

                  <Button
                    onClick={handleNext}
                    variant="outline"
                    size="sm"
                    className="text-terminal w-32"
                  >
                    {isLastPage ? "Dismiss" : "Continue"}
                    {!isLastPage && <ArrowRightIcon />}
                  </Button>
                </div>
              </motion.div>
            </Card>
          </div>
        </div>
      )}
    </BaseDialog>
  )
}
