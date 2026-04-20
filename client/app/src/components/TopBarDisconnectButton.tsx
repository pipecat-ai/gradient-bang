import { PlugsIcon, SignOutIcon } from "@phosphor-icons/react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/primitives/AlertDialog"
import useGameStore from "@/stores/game"

import { Button } from "./primitives/Button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

export const TopBarDisconnectButton = () => {
  const handleDisconnect = () => {
    useGameStore.getState().disconnectAndReset()
  }

  return (
    <Tooltip>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Disconnect"
              className="hover:text-destructive-foreground hover:bg-destructive-background hover:border-destructive"
            >
              <SignOutIcon weight="bold" size={16} />
            </Button>
          </TooltipTrigger>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <PlugsIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will end your current session and return you to the login screen.
              <strong className="mt-2 block text-white">
                Your ship remains in the universe and can be destroyed while you are offline. Make
                sure you are in Federation Space before disconnecting.
              </strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <TooltipContent>
        <p>Disconnect</p>
      </TooltipContent>
    </Tooltip>
  )
}
