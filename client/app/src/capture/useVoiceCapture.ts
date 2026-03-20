import { useEffect } from "react"

import { usePipecatClientMediaTrack } from "@pipecat-ai/client-react"

import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import { useCaptureStore } from "@/stores/captureStore"

export function useVoiceCapture(): void {
  const { isConnected } = usePipecatConnectionState()
  const capture = useCaptureStore((s) => s.capture)
  const localTrack = usePipecatClientMediaTrack("audio", "local")
  const botTrack = usePipecatClientMediaTrack("audio", "bot")

  useEffect(() => {
    if (!isConnected) return
    useCaptureStore.getState().init()
    return () => useCaptureStore.getState().teardown()
  }, [isConnected])

  useEffect(() => {
    capture?.setLocalTrack(localTrack ?? null)
    capture?.setBotTrack(botTrack ?? null)
  }, [capture, localTrack, botTrack])
}
