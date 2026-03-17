import { useEffect, useRef } from "react"

import { usePipecatClientMediaTrack } from "@pipecat-ai/client-react"

import type { SocialReplayCapture } from "./SocialReplayCapture"
import { VoiceCapture } from "./VoiceCapture"

export function useVoiceCapture(capture: SocialReplayCapture): void {
  const localTrack = usePipecatClientMediaTrack("audio", "local")
  const botTrack = usePipecatClientMediaTrack("audio", "bot")

  const localCaptureRef = useRef<VoiceCapture | null>(null)
  const botCaptureRef = useRef<VoiceCapture | null>(null)

  // Player mic
  useEffect(() => {
    if (localTrack) {
      const vc = new VoiceCapture()
      vc.start(localTrack)
      localCaptureRef.current = vc
      capture.playerMicCapture = vc
    } else {
      localCaptureRef.current?.stop()
      localCaptureRef.current = null
      capture.playerMicCapture = null
    }

    return () => {
      localCaptureRef.current?.stop()
      localCaptureRef.current = null
      capture.playerMicCapture = null
    }
  }, [localTrack, capture])

  // Bot voice
  useEffect(() => {
    if (botTrack) {
      const vc = new VoiceCapture()
      vc.start(botTrack)
      botCaptureRef.current = vc
      capture.botVoiceCapture = vc
    } else {
      botCaptureRef.current?.stop()
      botCaptureRef.current = null
      capture.botVoiceCapture = null
    }

    return () => {
      botCaptureRef.current?.stop()
      botCaptureRef.current = null
      capture.botVoiceCapture = null
    }
  }, [botTrack, capture])
}
