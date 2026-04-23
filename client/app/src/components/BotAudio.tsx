import { useCallback, useEffect, useRef } from "react"

import { RTVIEvent } from "@pipecat-ai/client-js"
import { usePipecatClientMediaTrack, useRTVIClientEvent } from "@pipecat-ai/client-react"

import useGameStore from "@/stores/game"

export const BotAudio = () => {
  const audioRef = useRef<HTMLAudioElement>(null)
  const botAudioTrack = usePipecatClientMediaTrack("audio", "bot")
  const disableRemoteAudio = useGameStore((s) => s.settings.disableRemoteAudio)
  const remoteAudioVolume = useGameStore((s) => s.settings.remoteAudioVolume)

  useEffect(() => {
    if (!audioRef.current || !botAudioTrack) return
    // Skip reassignment if the track hasn't changed — replacing srcObject resets playback
    if (audioRef.current.srcObject) {
      const existing = (audioRef.current.srcObject as MediaStream).getAudioTracks()[0]
      if (existing?.id === botAudioTrack.id) return
    }
    audioRef.current.srcObject = new MediaStream([botAudioTrack])
  }, [botAudioTrack])

  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.muted = disableRemoteAudio
  }, [disableRemoteAudio])

  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.volume = remoteAudioVolume
  }, [remoteAudioVolume])

  useRTVIClientEvent(
    RTVIEvent.SpeakerUpdated,
    useCallback((speaker: { deviceId: string }) => {
      if (!audioRef.current) return
      // setSinkId is a real browser API but absent from TS's HTMLMediaElement types
      const el = audioRef.current as HTMLAudioElement & { setSinkId?: (id: string) => void }
      el.setSinkId?.(speaker.deviceId)
    }, [])
  )

  return <audio ref={audioRef} autoPlay />
}
