import { button, folder, useControls } from "leva"

import useGameStore from "@/stores/game"

export const useOnboardingControls = () => {
  useControls(() => ({
    Onboarding: folder(
      {
        ["Toggle Tutorial"]: button(() => {
          const { tutorialActive, handleTutorialStart, handleTutorialComplete } =
            useGameStore.getState()
          if (tutorialActive) {
            handleTutorialComplete()
          } else {
            handleTutorialStart()
          }
        }),
        ["Reveal ID"]: { value: "aside" },
        ["Reveal Element"]: button((get) => {
          const id = get("Onboarding.Reveal ID") as string
          if (id.trim()) {
            useGameStore.getState().revealTutorialElement(id.trim())
          }
        }),
        ["Step Target"]: { value: "aside" },
        ["Send Step"]: button((get) => {
          const target = get("Onboarding.Step Target") as string
          useGameStore.getState().handleTutorialStep({
            step: 0,
            target: target.trim() || undefined,
          })
        }),
        ["Complete Tutorial"]: button(() => {
          useGameStore.getState().handleTutorialComplete()
        }),
      },
      { collapsed: true, order: 4 }
    ),
  }))
}
