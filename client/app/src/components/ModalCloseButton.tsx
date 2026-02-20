import { Dialog } from "radix-ui"
import { XIcon } from "@phosphor-icons/react"

import { cn } from "@/utils/tailwind"

import { Button } from "./primitives/Button"

export const ModalCloseButton = ({
  handleClose,
  className,
}: {
  handleClose: () => void
  className?: string
}) => {
  return (
    <Dialog.Close asChild>
      <Button
        variant="secondary"
        size="icon-lg"
        onClick={handleClose}
        data-modal-close
        className={cn("fixed top-ui-md right-ui-md", className)}
      >
        <XIcon weight="bold" className="size-4" />
      </Button>
    </Dialog.Close>
  )
}
