import { useCallback, useEffect, useRef } from "react"

import { sounds as soundUrls } from "@/assets"
import useGameStore from "@/stores/game"

type SoundType = "fx" | "ambience" | "music"

// Type metadata for each sound (keep this here since it's audio-specific)
const soundTypes: Record<keyof typeof soundUrls, SoundType> = {
  warp: "fx",
  start: "fx",
  message: "fx",
  chime1: "fx",
  chime2: "fx",
  chime3: "fx",
  chime4: "fx",
  chime5: "fx",
  chime6: "fx",
  text: "fx",
  ambience: "ambience",
  currency: "fx",
}

type OnceSoundEntry = {
  audio: HTMLAudioElement
  baseVolume: number
  soundType: SoundType
  suspended: boolean
}

// Persist across hot module reloads using a global singleton
const _g = globalThis as typeof globalThis & {
  __gb_activeOnceSounds?: Map<string, OnceSoundEntry>
  __gb_soundCache?: Map<string, HTMLAudioElement>
}
_g.__gb_activeOnceSounds =
  _g.__gb_activeOnceSounds || new Map<string, OnceSoundEntry>()
const activeOnceSounds = _g.__gb_activeOnceSounds as Map<string, OnceSoundEntry>

// Global cache for sounds (persists across HMR)
_g.__gb_soundCache = _g.__gb_soundCache || new Map<string, HTMLAudioElement>()
const soundCache = _g.__gb_soundCache as Map<string, HTMLAudioElement>

export const usePlaySound = () => {
  const settings = useGameStore.use.settings()
  const {
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  } = settings

  // Store latest settings in a ref so playSound callback can access them
  const settingsRef = useRef({
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  })

  // Keep ref up to date
  useEffect(() => {
    settingsRef.current = {
      ambienceVolume,
      soundFXVolume,
      musicVolume,
      disabledAmbience,
      disabledSoundFX,
      disableMusic,
    }
  }, [
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  ])

  // Handle volume/mute changes for active once sounds
  useEffect(() => {
    activeOnceSounds.forEach((entry) => {
      const { audio, baseVolume, soundType } = entry

      let finalVolume = baseVolume
      if (soundType === "ambience") {
        finalVolume = baseVolume * ambienceVolume
      } else if (soundType === "fx") {
        finalVolume = baseVolume * soundFXVolume
      } else if (soundType === "music") {
        finalVolume = baseVolume * musicVolume
      }
      audio.volume = finalVolume

      const disabled =
        (soundType === "ambience" && disabledAmbience) ||
        (soundType === "fx" && disabledSoundFX) ||
        (soundType === "music" && disableMusic)

      if (disabled) {
        if (!audio.paused) {
          audio.pause()
        }
        entry.suspended = true
      } else {
        if (audio.paused && entry.suspended) {
          const p = audio.play()
          if (p) {
            p.catch(() => {
              // ignore play errors, e.g. autoplay restrictions
            })
          }
          entry.suspended = false
        }
      }
    })
  }, [
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  ])

  const playSound = useCallback(
    (
      soundName: keyof typeof soundUrls,
      options?: { volume?: number; loop?: boolean; once?: boolean }
    ) => {
      if (options?.once && activeOnceSounds.has(soundName)) {
        return // Already playing as "once"
      }

      const soundUrl = soundUrls[soundName]
      const soundType = soundTypes[soundName]

      if (!soundUrl || !soundType) {
        console.warn(`[SOUND] Unknown sound: ${soundName}`)
        return
      }

      const {
        ambienceVolume: currentAmbienceVolume,
        soundFXVolume: currentSoundFXVolume,
        musicVolume: currentMusicVolume,
        disabledAmbience: currentDisabledAmbience,
        disabledSoundFX: currentDisabledSoundFX,
        disableMusic: currentDisableMusic,
      } = settingsRef.current

      const isDisabled =
        (soundType === "ambience" && currentDisabledAmbience) ||
        (soundType === "fx" && currentDisabledSoundFX) ||
        (soundType === "music" && currentDisableMusic)

      if (!options?.once && isDisabled) {
        return // Don't play if disabled
      }

      // Use cached audio if available; clone for concurrent non-loop plays
      const cached = soundCache.get(soundName)
      let audio: HTMLAudioElement

      if (cached) {
        if (!options?.once && !options?.loop) {
          audio = cached.cloneNode() as HTMLAudioElement
        } else {
          audio = cached
        }
      } else {
        // Create new Audio - will be cached by browser/SW from preload
        audio = new Audio(soundUrl)
        soundCache.set(soundName, audio)
      }

      audio.currentTime = 0

      // Calculate volume
      const baseVolume = options?.volume ?? 1
      let finalVolume = baseVolume
      if (soundType === "ambience") {
        finalVolume = baseVolume * currentAmbienceVolume
      } else if (soundType === "fx") {
        finalVolume = baseVolume * currentSoundFXVolume
      } else if (soundType === "music") {
        finalVolume = baseVolume * currentMusicVolume
      }
      audio.volume = finalVolume

      // Set loop if needed
      if (options?.once || options?.loop) {
        audio.loop = true
      }

      // Track once sounds
      if (options?.once) {
        activeOnceSounds.set(soundName, {
          audio,
          baseVolume,
          soundType,
          suspended: isDisabled,
        })
      }

      // Play if not disabled
      if (!isDisabled) {
        const playPromise = audio.play()
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.warn(`[SOUND] Failed to play ${soundName}:`, error)
          })
        }
      }
    },
    []
  )

  const stopSound = useCallback((soundName: keyof typeof soundUrls) => {
    const entry = activeOnceSounds.get(soundName)
    if (entry) {
      entry.audio.pause()
      entry.audio.currentTime = 0
      activeOnceSounds.delete(soundName)
    }
  }, [])

  return { playSound, stopSound }
}

export default usePlaySound
