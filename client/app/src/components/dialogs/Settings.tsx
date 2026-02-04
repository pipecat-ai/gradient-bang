import { AnimatePresence, motion } from "motion/react"
import { Dialog } from "radix-ui"

import { Card, CardHeader, CardTitle } from "@/components/primitives/Card"
import { SettingsPanel } from "@/components/SettingsPanel"
import useGameStore from "@/stores/game"

import { ModalCloseButton } from "../ModalCloseButton"

export const Settings = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()

  const handleSave = () => {
    setActiveModal(undefined)
  }

  return (
    <Dialog.Root open={activeModal === "settings"} onOpenChange={() => setActiveModal(undefined)}>
      <Dialog.Portal>
        <AnimatePresence>
          {activeModal === "settings" && (
            <Dialog.Overlay>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="DialogOverlay bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm text-subtle dialog-dots"
              >
                <Dialog.Title>Settings</Dialog.Title>
                <Dialog.Content
                  asChild
                  aria-describedby={undefined}
                  className="DialogContent max-w-xl"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                  >
                    <ModalCloseButton handleClose={() => setActiveModal(undefined)} />
                    <Card
                      elbow={true}
                      size="default"
                      className="w-full h-full max-h-max bg-black shadow-2xl"
                    >
                      <CardHeader>
                        <CardTitle className="heading-2">Settings</CardTitle>
                      </CardHeader>
                      <SettingsPanel
                        onSave={handleSave}
                        onCancel={() => setActiveModal(undefined)}
                      />
                    </Card>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
