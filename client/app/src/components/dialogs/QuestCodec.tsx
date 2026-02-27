import { useEffect, useMemo, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { ArrowRightIcon, CaretLeftIcon, WaveSineIcon } from "@phosphor-icons/react"

import CharacterPortrait1 from "@/assets/images/characters/fed-cadet-1.png"
import CharacterPortrait2 from "@/assets/images/characters/fed-cadet-2.png"
import { DottedTitle } from "@/components/DottedTitle"
import { Button } from "@/components/primitives/Button"
import { Card } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"
import { stripTags } from "@/utils/tts"

import { BaseDialog } from "./BaseDialog"

import type { SayTextAction } from "@/types/actions"

const VOICE_ID_MAP = {
  cadet_amy: "6ccbfb76-1fc6-48f7-b71d-91ac6298247b",
  commander_voss: "0ad65e7f-006c-47cf-bd31-52279d487913",
}

export const QuestCodec = () => {
  const getActiveCodec = useGameStore.use.getActiveCodec()
  const codecQuestId = useGameStore((state) => state.notifications.incomingCodec)
  const viewCodec = useGameStore.use.viewCodec?.()
  const setViewCodec = useGameStore.use.setViewCodec()
  const setNotifications = useGameStore.use.setNotifications()
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const dispatchAction = useGameStore.use.dispatchAction()

  const isOpen = activeModal?.modal === "quest_codec"
  const diamondRef = useRef<HTMLDivElement>(null)

  const [page, setPage] = useState(0)

  const codec = isOpen ? (viewCodec ?? getActiveCodec(codecQuestId || undefined)) : null
  const giverId = codec?.giver_id
  const pages = useMemo(() => codec?.pages ?? [], [codec?.pages])
  const totalPages = pages.length
  const isLastPage = page >= totalPages - 1

  // Read back the current page text via TTS whenever the page changes
  useEffect(() => {
    if (!isOpen || !pages[page] || !giverId) return
    dispatchAction({
      type: "say-text",
      payload: {
        voice_id:
          VOICE_ID_MAP[giverId as keyof typeof VOICE_ID_MAP] ??
          "6ccbfb76-1fc6-48f7-b71d-91ac6298247b",
        text: pages[page],
      },
    } as SayTextAction)
  }, [isOpen, page, pages, giverId, dispatchAction])

  function dismiss() {
    setActiveModal(undefined)
    setPage(0)
    setViewCodec(null)
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
      useDiamondFX
      diamondRef={diamondRef}
      dismissOnClickOutside={false}
      onClose={dismiss}
    >
      {codec && (
        <div className="relative flex flex-row items-end gap-0 w-3xl">
          {/* Portrait — full size, anchored to bottom */}
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="shrink-0 absolute left-0 bottom-0 z-10"
          >
            <img
              src={codec?.giver_id === "commander_voss" ? CharacterPortrait2 : CharacterPortrait1}
              alt={codec?.giver}
              className="h-80 w-auto object-contain z-20"
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="absolute left-0 w-fit bg-background text-foreground leading-none px-2.5 pl-2 py-1.5 gap-2 outline-1 outline-terminal border-l-7 border-terminal/30 font-medium uppercase text-xs pointer-events-none bottom-0 translate-y-1/2 z-30 flex flex-row items-center"
          >
            <WaveSineIcon size={16} weight="bold" className="size-3.5 text-terminal" />{" "}
            {codec?.giver}
          </motion.div>

          {/* Dialog panel */}
          <div ref={diamondRef} className="w-full shadow-xlong">
            <Card className="px-ui-md pl-70 mask-[linear-gradient(to_right,transparent_20%,black_calc(var(--spacing)*70))] elbow elbow-offset-1 gap-ui-md">
              {/* Header */}

              <DottedTitle title="Incoming Transmission" className="w-full" />

              {/* Page text */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.7 }}
                className="relative min-h-[6lh] text-sm"
              >
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
              </motion.div>

              {/* Navigation */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 1 }}
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
