import { create, type StoreApi, type UseBoundStore } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

import { sounds as soundUrls } from "@/assets"

import useGameStore from "./game"

type SoundName = keyof typeof soundUrls
type SoundType = "fx" | "ambience" | "music"

interface PlaySoundOptions {
  volume?: number
  loop?: boolean
  once?: boolean
}

interface OnceSoundEntry {
  audio: HTMLAudioElement
  baseVolume: number
  soundType: SoundType
  suspended: boolean
}

// Type metadata for each sound
const soundTypes: Record<SoundName, SoundType> = {
  enter: "fx",
  enterCombat: "fx",
  message: "fx",
  chime1: "fx",
  chime2: "fx",
  chime3: "fx",
  chime4: "fx",
  chime5: "fx",
  chime6: "fx",
  chime7: "fx",
  text: "fx",
  ambience: "ambience",
  currency: "fx",
  impact1: "fx",
  impact2: "fx",
  impact3: "fx",
  impact4: "fx",
}

interface AudioState {
  soundCache: Map<SoundName, HTMLAudioElement>
  activeOnceSounds: Map<SoundName, OnceSoundEntry>
  playSound: (soundName: SoundName, options?: PlaySoundOptions) => void
  stopSound: (soundName: SoundName) => void
  syncAudioVolumes: () => void
}

type WithSelectors<S> =
  S extends { getState: () => infer T } ? S & { use: { [K in keyof T]: () => T[K] } } : never

const createSelectors = <S extends UseBoundStore<StoreApi<object>>>(_store: S) => {
  const store = _store as WithSelectors<typeof _store>
  store.use = {}
  for (const k of Object.keys(store.getState())) {
    ;(store.use as Record<string, () => unknown>)[k] = () => store((s) => s[k as keyof typeof s])
  }
  return store
}

const useAudioStoreBase = create<AudioState>()(
  subscribeWithSelector((set, get) => ({
    soundCache: new Map(),
    activeOnceSounds: new Map(),

    playSound: (soundName: SoundName, options?: PlaySoundOptions) => {
      const { soundCache, activeOnceSounds } = get()
      const settings = useGameStore.getState().settings

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
        ambienceVolume,
        soundFXVolume,
        musicVolume,
        disabledAmbience,
        disabledSoundFX,
        disableMusic,
      } = settings

      const isDisabled =
        (soundType === "ambience" && disabledAmbience) ||
        (soundType === "fx" && disabledSoundFX) ||
        (soundType === "music" && disableMusic)

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
        finalVolume = baseVolume * ambienceVolume
      } else if (soundType === "fx") {
        finalVolume = baseVolume * soundFXVolume
      } else if (soundType === "music") {
        finalVolume = baseVolume * musicVolume
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

    stopSound: (soundName: SoundName) => {
      const { activeOnceSounds } = get()
      const entry = activeOnceSounds.get(soundName)
      if (entry) {
        entry.audio.pause()
        entry.audio.currentTime = 0
        activeOnceSounds.delete(soundName)
      }
    },

    syncAudioVolumes: () => {
      const { activeOnceSounds } = get()
      const settings = useGameStore.getState().settings
      const {
        ambienceVolume,
        soundFXVolume,
        musicVolume,
        disabledAmbience,
        disabledSoundFX,
        disableMusic,
      } = settings

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
    },
  }))
)

// Subscribe to game store settings changes and sync audio volumes
useGameStore.subscribe(
  (state) => ({
    ambienceVolume: state.settings.ambienceVolume,
    soundFXVolume: state.settings.soundFXVolume,
    musicVolume: state.settings.musicVolume,
    disabledAmbience: state.settings.disabledAmbience,
    disabledSoundFX: state.settings.disabledSoundFX,
    disableMusic: state.settings.disableMusic,
  }),
  () => {
    useAudioStoreBase.getState().syncAudioVolumes()
  }
)

const useAudioStore = createSelectors(useAudioStoreBase)

export default useAudioStore
