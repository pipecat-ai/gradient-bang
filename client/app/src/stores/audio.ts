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

interface FadeOptions {
  volume?: number
  duration?: number
  loop?: boolean
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
  chime8: "fx",
  text: "fx",
  currency: "fx",
  impact1: "fx",
  impact2: "fx",
  impact3: "fx",
  impact4: "fx",
  codec1: "fx",
  codec2: "fx",
  theme: "music",
}

// --- Shared AudioContext singleton ---

let _audioContext: AudioContext | null = null

export function getSharedAudioContext(): AudioContext {
  if (!_audioContext || _audioContext.state === "closed") {
    _audioContext = new AudioContext()
  }
  if (_audioContext.state === "suspended") {
    _audioContext.resume()
  }
  return _audioContext
}

// --- Decoded AudioBuffer cache ---

const bufferCache = new Map<SoundName, AudioBuffer>()
const pendingDecodes = new Map<SoundName, Promise<AudioBuffer | null>>()
let decodeAllStarted = false

async function decodeAllBuffers() {
  if (decodeAllStarted) return
  decodeAllStarted = true

  const ctx = getSharedAudioContext()
  await Promise.allSettled(
    (Object.entries(soundUrls) as [SoundName, string][]).map(async ([name, url]) => {
      if (bufferCache.has(name)) return
      try {
        const response = await fetch(url)
        const arrayBuffer = await response.arrayBuffer()
        const buffer = await ctx.decodeAudioData(arrayBuffer)
        bufferCache.set(name, buffer)
      } catch (err) {
        console.warn(`[SOUND] Failed to decode ${name}:`, err)
      }
    })
  )
}

async function getBuffer(soundName: SoundName): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(soundName)
  if (cached) return cached

  // Prevent duplicate decodes of the same sound
  const pending = pendingDecodes.get(soundName)
  if (pending) return pending

  const url = soundUrls[soundName]
  if (!url) return null

  const promise = (async () => {
    try {
      const ctx = getSharedAudioContext()
      const response = await fetch(url)
      const arrayBuffer = await response.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      bufferCache.set(soundName, buffer)
      return buffer
    } catch (err) {
      console.warn(`[SOUND] Failed to decode ${soundName}:`, err)
      return null
    } finally {
      pendingDecodes.delete(soundName)
    }
  })()

  pendingDecodes.set(soundName, promise)
  return promise
}

// --- Helpers ---

interface ActiveSound {
  source: AudioBufferSourceNode
  gain: GainNode
  baseVolume: number
  soundType: SoundType
  suspended: boolean
}

function getTypeMultiplier(
  soundType: SoundType,
  settings: ReturnType<typeof useGameStore.getState>["settings"]
): number {
  if (soundType === "ambience") return settings.ambienceVolume
  if (soundType === "fx") return settings.soundFXVolume
  if (soundType === "music") return settings.musicVolume
  return 1
}

function isSoundDisabled(
  soundType: SoundType,
  settings: ReturnType<typeof useGameStore.getState>["settings"]
): boolean {
  return (
    (soundType === "ambience" && settings.disabledAmbience) ||
    (soundType === "fx" && settings.disabledSoundFX) ||
    (soundType === "music" && settings.disableMusic)
  )
}

function startSound(
  buffer: AudioBuffer,
  volume: number,
  loop: boolean
): { source: AudioBufferSourceNode; gain: GainNode } {
  const ctx = getSharedAudioContext()
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = loop

  const gain = ctx.createGain()
  gain.gain.value = volume

  source.connect(gain)
  gain.connect(ctx.destination)
  source.start(0)

  return { source, gain }
}

// --- Store ---

interface AudioState {
  activeOnceSounds: Map<SoundName, ActiveSound>
  playSound: (soundName: SoundName, options?: PlaySoundOptions) => void
  stopSound: (soundName: SoundName) => void
  fadeIn: (soundName: SoundName, options?: FadeOptions) => void
  fadeOut: (soundName: SoundName, options?: { duration?: number }) => void
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

function playSoundWithBuffer(
  soundName: SoundName,
  buffer: AudioBuffer,
  options: PlaySoundOptions | undefined,
  activeOnceSounds: Map<SoundName, ActiveSound>
) {
  const settings = useGameStore.getState().settings
  const soundType = soundTypes[soundName]
  const isDisabled = isSoundDisabled(soundType, settings)
  const baseVolume = options?.volume ?? 1
  const typeMultiplier = getTypeMultiplier(soundType, settings)
  const finalVolume = isDisabled ? 0 : baseVolume * typeMultiplier
  const loop = !!(options?.once || options?.loop)

  const { source, gain } = startSound(buffer, finalVolume, loop)

  if (options?.once) {
    activeOnceSounds.set(soundName, {
      source,
      gain,
      baseVolume,
      soundType,
      suspended: isDisabled,
    })
  } else {
    // Fire-and-forget: auto-cleanup when done
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
    }
  }
}

const useAudioStoreBase = create<AudioState>()(
  subscribeWithSelector((_set, get) => ({
    activeOnceSounds: new Map(),

    playSound: (soundName: SoundName, options?: PlaySoundOptions) => {
      const { activeOnceSounds } = get()
      const settings = useGameStore.getState().settings
      const soundType = soundTypes[soundName]

      if (!soundType) {
        console.warn(`[SOUND] Unknown sound: ${soundName}`)
        return
      }

      if (options?.once && activeOnceSounds.has(soundName)) {
        return
      }

      const isDisabled = isSoundDisabled(soundType, settings)
      if (!options?.once && isDisabled) {
        return
      }

      // Trigger decode of all sounds on first play (preloader ensures HTTP cache hits)
      decodeAllBuffers()

      const buffer = bufferCache.get(soundName)
      if (buffer) {
        playSoundWithBuffer(soundName, buffer, options, activeOnceSounds)
      } else {
        // First play of this sound — decode and play async
        getBuffer(soundName).then((buf) => {
          if (!buf) return
          // Re-check "once" guard after async gap
          if (options?.once && get().activeOnceSounds.has(soundName)) return
          playSoundWithBuffer(soundName, buf, options, get().activeOnceSounds)
        })
      }
    },

    stopSound: (soundName: SoundName) => {
      const { activeOnceSounds } = get()
      const entry = activeOnceSounds.get(soundName)
      if (entry) {
        try {
          entry.source.stop()
        } catch {
          /* already stopped */
        }
        entry.source.disconnect()
        entry.gain.disconnect()
        activeOnceSounds.delete(soundName)
      }
    },

    fadeIn: (soundName: SoundName, options?: FadeOptions) => {
      const { playSound } = get()
      const duration = options?.duration ?? 1000

      // Start the sound at volume 0 as a "once" (looping/persistent) sound
      playSound(soundName, { volume: 0, once: true, loop: options?.loop })

      const applyRamp = () => {
        const entry = get().activeOnceSounds.get(soundName)
        if (!entry) return false

        const targetBaseVolume = options?.volume ?? 1
        entry.baseVolume = targetBaseVolume

        const settings = useGameStore.getState().settings
        const typeMultiplier = getTypeMultiplier(entry.soundType, settings)
        const targetVolume = targetBaseVolume * typeMultiplier

        const ctx = getSharedAudioContext()
        const now = ctx.currentTime
        entry.gain.gain.cancelScheduledValues(now)
        entry.gain.gain.setValueAtTime(0, now)
        entry.gain.gain.linearRampToValueAtTime(targetVolume, now + duration / 1000)
        return true
      }

      // Try immediately — if buffer was cached, the sound is already playing
      if (!applyRamp()) {
        // Sound is being decoded async; poll briefly until it's ready
        let attempts = 0
        const interval = setInterval(() => {
          attempts++
          if (applyRamp() || attempts > 50) {
            clearInterval(interval)
          }
        }, 20)
      }
    },

    fadeOut: (soundName: SoundName, options?: { duration?: number }) => {
      const { activeOnceSounds } = get()
      const duration = options?.duration ?? 1000

      const entry = activeOnceSounds.get(soundName)
      if (!entry) return

      // Schedule gain ramp to 0 on the audio thread (no setInterval)
      const ctx = getSharedAudioContext()
      const now = ctx.currentTime
      entry.gain.gain.cancelScheduledValues(now)
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now)
      entry.gain.gain.linearRampToValueAtTime(0, now + duration / 1000)

      // Cleanup after fade completes
      setTimeout(() => {
        try {
          entry.source.stop()
        } catch {
          /* already stopped */
        }
        entry.source.disconnect()
        entry.gain.disconnect()
        get().activeOnceSounds.delete(soundName)
      }, duration + 50)
    },

    syncAudioVolumes: () => {
      const { activeOnceSounds } = get()
      const settings = useGameStore.getState().settings

      activeOnceSounds.forEach((entry) => {
        const { baseVolume, soundType } = entry
        const typeMultiplier = getTypeMultiplier(soundType, settings)
        const disabled = isSoundDisabled(soundType, settings)
        const targetVolume = disabled ? 0 : baseVolume * typeMultiplier

        entry.gain.gain.value = targetVolume
        entry.suspended = disabled
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
