import { useCallback, useEffect, useRef } from "react"

import { RTVIEvent } from "@pipecat-ai/client-js"
import { usePipecatClientMediaTrack, useRTVIClientEvent } from "@pipecat-ai/client-react"

import useGameStore from "@/stores/game"

export const PipecatClientAudio: React.FC = () => {
  const audioRef = useRef<HTMLAudioElement>(null)
  const botAudioTrack = usePipecatClientMediaTrack("audio", "bot")
  const volume = useGameStore((state) => state.settings.remoteAudioVolume)

  // Attach the bot's audio track to the <audio> element, de-duping on track id
  // so we don't tear down an already-playing stream.
  useEffect(() => {
    const el = audioRef.current
    if (!el || !botAudioTrack) return
    const existing = el.srcObject as MediaStream | null
    if (existing) {
      const oldTrack = existing.getAudioTracks()[0]
      if (oldTrack && oldTrack.id === botAudioTrack.id) return
    }
    el.srcObject = new MediaStream([botAudioTrack])
  }, [botAudioTrack])

  // Bind store volume to the media element.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.volume = volume
  }, [volume])

  // Mirror PipecatClientAudio's speaker routing behavior. `setSinkId` returns
  // a Promise that can reject (unsupported deviceId, permission denied, etc.);
  // swallow and log so failures stay non-fatal and observable.
  useRTVIClientEvent(
    RTVIEvent.SpeakerUpdated,
    useCallback((speaker: MediaDeviceInfo) => {
      const el = audioRef.current
      if (!el) return
      if (typeof el.setSinkId !== "function") return
      el.setSinkId(speaker.deviceId).catch((err: unknown) => {
        console.warn("PipecatClientAudio: setSinkId failed", err)
      })
    }, [])
  )

  return <audio ref={audioRef} autoPlay />
}

PipecatClientAudio.displayName = "PipecatClientAudio"

export default PipecatClientAudio
