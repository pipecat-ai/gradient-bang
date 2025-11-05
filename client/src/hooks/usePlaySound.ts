import useGameStore from "@stores/game";
import { useCallback, useEffect, useRef } from "react";

export type Sound = {
  src: string;
  type: SoundType;
};

type SoundType = "fx" | "ambience" | "music";

const SoundMap: Record<string, Sound> = {
  warp: { src: "/sounds/warp.wav", type: "fx" },
  start: { src: "/sounds/start.wav", type: "fx" },
  message: { src: "/sounds/message.wav", type: "fx" },
  chime1: { src: "/sounds/chime-1.wav", type: "fx" },
  chime2: { src: "/sounds/chime-2.wav", type: "fx" },
  chime3: { src: "/sounds/chime-3.wav", type: "fx" },
  chime4: { src: "/sounds/chime-4.wav", type: "fx" },
  chime5: { src: "/sounds/chime-5.wav", type: "fx" },
  chime6: { src: "/sounds/chime-6.wav", type: "fx" },
  text: { src: "/sounds/text.wav", type: "fx" },
  ambience: { src: "/sounds/ambience.wav", type: "ambience" },
};

type OnceSoundEntry = {
  audio: HTMLAudioElement;
  baseVolume: number;
  soundType: SoundType;
  suspended: boolean;
};

// Persist across hot module reloads using a global singleton
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as any;
_g.__gb_activeOnceSounds =
  _g.__gb_activeOnceSounds || new Map<string, OnceSoundEntry>();
const activeOnceSounds = _g.__gb_activeOnceSounds as Map<
  string,
  OnceSoundEntry
>;

// Global cache for preloaded sounds (persists across HMR)
_g.__gb_soundCache = _g.__gb_soundCache || new Map<string, HTMLAudioElement>();
const soundCache = _g.__gb_soundCache as Map<string, HTMLAudioElement>;

// Track if we've already attempted preloading
_g.__gb_soundsPreloaded = _g.__gb_soundsPreloaded || false;

// Preload all sounds defined in SoundMap
export const preloadAllSounds = (): Promise<void> => {
  if (_g.__gb_soundsPreloaded) {
    console.debug("[SOUND] preloadAllSounds: already preloaded, skipping");
    return Promise.resolve();
  }

  const entries = Object.entries(SoundMap);
  console.debug(
    `[SOUND] preloadAllSounds: starting (${entries.length} sounds)`
  );

  const loadPromises = entries.map(([name, sound]) => {
    return new Promise<void>((resolve) => {
      // If already cached, skip
      if (soundCache.has(name)) {
        console.debug(`[SOUND] preloadAllSounds: cache hit, skipping ${name}`);
        resolve();
        return;
      }

      const audio = new Audio(sound.src);
      console.debug(
        `[SOUND] preloadAllSounds: loading ${name} from ${sound.src}`
      );

      const onReady = () => {
        soundCache.set(name, audio);
        console.debug(`[SOUND] preloadAllSounds: ready ${name}`);
        resolve();
      };

      const onError = (e: unknown) => {
        // Resolve (not reject) so a single failed asset doesn't block the preload phase
        console.error(
          `[SOUND] preloadAllSounds: failed ${name} (${sound.src})`,
          e
        );
        resolve();
      };

      audio.addEventListener("canplaythrough", onReady, { once: true });
      audio.addEventListener("error", onError, { once: true });

      // Start loading
      audio.load();
    });
  });

  return Promise.all(loadPromises).then(() => {
    _g.__gb_soundsPreloaded = true;
    console.debug("[SOUND] preloadAllSounds: completed");
  });
};

export const usePlaySound = () => {
  const settings = useGameStore.use.settings();
  const {
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  } = settings;

  // Store latest settings in a ref so playSound callback can access them
  // without needing to be recreated
  const settingsRef = useRef({
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  });

  // Keep ref up to date
  useEffect(() => {
    settingsRef.current = {
      ambienceVolume,
      soundFXVolume,
      musicVolume,
      disabledAmbience,
      disabledSoundFX,
      disableMusic,
    };
  }, [
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  ]);

  useEffect(() => {
    activeOnceSounds.forEach((entry) => {
      const { audio, baseVolume, soundType } = entry;

      let finalVolume = baseVolume;
      if (soundType === "ambience") {
        finalVolume = baseVolume * ambienceVolume;
      } else if (soundType === "fx") {
        finalVolume = baseVolume * soundFXVolume;
      } else if (soundType === "music") {
        finalVolume = baseVolume * musicVolume;
      }
      audio.volume = finalVolume;

      const disabled =
        (soundType === "ambience" && disabledAmbience) ||
        (soundType === "fx" && disabledSoundFX) ||
        (soundType === "music" && disableMusic);

      if (disabled) {
        if (!audio.paused) {
          audio.pause();
        }
        entry.suspended = true;
        console.debug(
          `[SOUND] once sound suspended due to settings (type=${soundType})`
        );
      } else {
        if (audio.paused && entry.suspended) {
          const p = audio.play();
          if (p) {
            p.catch(() => {
              // ignore play errors, e.g. autoplay restrictions
              // @TODO: handle this
            });
          }
          entry.suspended = false;
          console.debug(
            `[SOUND] once sound resumed (type=${soundType}, volume=${audio.volume.toFixed(
              2
            )})`
          );
        }
      }
    });
  }, [
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  ]);

  const playSound = useCallback(
    (
      soundName: string,
      options?: { volume?: number; loop?: boolean; once?: boolean }
    ) => {
      console.debug("[SOUND] playSound called", { soundName, options });
      if (options?.once && activeOnceSounds.has(soundName)) {
        console.debug(
          `[SOUND] playSound: ${soundName} already active (once) — skipping`
        );
        return;
      }

      const sound = SoundMap[soundName as keyof typeof SoundMap];
      if (!sound) {
        console.warn(`[SOUND] playSound: unknown sound "${soundName}"`);
        return;
      }

      const {
        ambienceVolume: currentAmbienceVolume,
        soundFXVolume: currentSoundFXVolume,
        musicVolume: currentMusicVolume,
        disabledAmbience: currentDisabledAmbience,
        disabledSoundFX: currentDisabledSoundFX,
        disableMusic: currentDisableMusic,
      } = settingsRef.current;

      const isDisabled =
        (sound.type === "ambience" && currentDisabledAmbience) ||
        (sound.type === "fx" && currentDisabledSoundFX) ||
        (sound.type === "music" && currentDisableMusic);

      if (!options?.once && isDisabled) {
        console.debug(
          `[SOUND] playSound: ${soundName} disabled by settings (type=${sound.type})`
        );
        return;
      }

      // Use preloaded audio if available; clone for concurrent non-loop plays
      const cached = soundCache.get(soundName);
      let audio: HTMLAudioElement;
      if (cached) {
        if (!options?.once && !options?.loop) {
          audio = cached.cloneNode() as HTMLAudioElement;
          console.debug(
            `[SOUND] playSound: using cached audio (cloned) for ${soundName}`
          );
        } else {
          audio = cached;
          console.debug(
            `[SOUND] playSound: using cached audio for ${soundName}`
          );
        }
      } else {
        audio = new Audio(sound.src);
        console.debug(
          `[SOUND] playSound: created new Audio for ${soundName} from ${sound.src}`
        );
      }

      audio.currentTime = 0;

      const baseVolume = options?.volume ?? 1;
      let finalVolume = baseVolume;
      if (sound.type === "ambience") {
        finalVolume = baseVolume * currentAmbienceVolume;
      } else if (sound.type === "fx") {
        finalVolume = baseVolume * currentSoundFXVolume;
      } else if (sound.type === "music") {
        finalVolume = baseVolume * currentMusicVolume;
      }
      audio.volume = finalVolume;
      console.debug(
        `[SOUND] volume: ${soundName} base=${baseVolume} final=${finalVolume.toFixed(
          2
        )} type=${
          sound.type
        } settings={ambience:${currentAmbienceVolume}, fx:${currentSoundFXVolume}, music:${currentMusicVolume}}`
      );

      if (options?.once || options?.loop) {
        audio.loop = true;
        console.debug(
          `[SOUND] loop enabled for ${soundName} (once=${!!options?.once}, loop=${!!options?.loop})`
        );
      }

      if (options?.once) {
        activeOnceSounds.set(soundName, {
          audio,
          baseVolume,
          soundType: sound.type,
          suspended: isDisabled,
        });
        console.debug(`[SOUND] registered once sound ${soundName}`);
      }

      if (!isDisabled) {
        console.debug(`[SOUND] playing ${soundName}`);
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.warn(`[SOUND] Failed to play sound ${soundName}:`, error);
          });
        }
      }
    },
    []
  );

  (
    playSound as unknown as { preloadSounds?: () => Promise<void> }
  ).preloadSounds = preloadAllSounds;

  return playSound;
};

export default usePlaySound;
