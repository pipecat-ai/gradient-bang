// Images
import port1 from "./images/ports/port-1.png"
import port2 from "./images/ports/port-2.png"
import port3 from "./images/ports/port-3.png"
import skybox1 from "./images/skybox-1.png"
import skybox2 from "./images/skybox-2.png"
import skybox3 from "./images/skybox-3.png"
import skybox4 from "./images/skybox-4.png"
import skybox5 from "./images/skybox-5.png"
import skybox6 from "./images/skybox-6.png"
import skybox7 from "./images/skybox-7.png"
import skybox8 from "./images/skybox-8.png"
import skybox9 from "./images/skybox-9.png"
import splash1 from "./images/splash-1.png"
// Sounds
import ambienceSound from "./sounds/ambience.wav"
import chime1Sound from "./sounds/chime-1.wav"
import chime2Sound from "./sounds/chime-2.wav"
import chime3Sound from "./sounds/chime-3.wav"
import chime4Sound from "./sounds/chime-4.wav"
import chime5Sound from "./sounds/chime-5.wav"
import chime6Sound from "./sounds/chime-6.wav"
import currencySound from "./sounds/currency.wav"
import messageSound from "./sounds/message.wav"
import startSound from "./sounds/start.wav"
import textSound from "./sounds/text.wav"
import warpSound from "./sounds/warp.wav"
// Videos
import planetLoadingVideo from "./videos/planet-loader.mp4"
import titleVideo from "./videos/title.mp4"

export const images = {
  splash1,
} as const

export const portImages = {
  port1,
  port2,
  port3,
}

export const skyboxImages = {
  skybox1,
  skybox2,
  skybox3,
  skybox4,
  skybox5,
  skybox6,
  skybox7,
  skybox8,
  skybox9,
} as const

export const videos = {
  title: titleVideo,
  planetLoading: planetLoadingVideo,
} as const

export const sounds = {
  warp: warpSound,
  start: startSound,
  message: messageSound,
  chime1: chime1Sound,
  chime2: chime2Sound,
  chime3: chime3Sound,
  chime4: chime4Sound,
  chime5: chime5Sound,
  chime6: chime6Sound,
  text: textSound,
  ambience: ambienceSound,
  currency: currencySound,
} as const

// JS Chunks - preload lazy-loaded components and their dependencies
export const chunks = {
  starfield: () => import("@/components/StarfieldLazy"),
} as const
