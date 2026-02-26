// Images
// Characters
import character1 from "./images/characters/fed-cadet-1.png"
import character2 from "./images/characters/fed-cadet-2.png"
import port1 from "./images/ports/port-1.png"
import port2 from "./images/ports/port-2.png"
import port3 from "./images/ports/port-3.png"
import aegisCruiserLogo from "./images/ships/aegis_cruiser_logo.png"
import atlasHaulerLogo from "./images/ships/atlas_hauler_logo.png"
import autonomousLightHaulerLogo from "./images/ships/autonomous_light_hauler_logo.png"
import autonomousProbeLogo from "./images/ships/autonomous_probe_logo.png"
import bulwarkDestroyerLogo from "./images/ships/bulwark_destroyer_logo.png"
import corsairRaiderLogo from "./images/ships/corsair_raider_logo.png"
import escapePodLogo from "./images/ships/escape_pod_logo.png"
import kestrelLogo from "./images/ships/kestrel_courier_logo.png"
import pikeFrigateLogo from "./images/ships/pike_frigate_logo.png"
import pioneerLifterLogo from "./images/ships/pioneer_lifter_logo.png"
import sovereignStarcruiserLogo from "./images/ships/sovereign_starcruiser_logo.png"
import sparrowScoutLogo from "./images/ships/sparrow_scout_logo.png"
import wayfarerFreighterLogo from "./images/ships/wayfarer_freighter_logo.png"
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
import chime1Sound from "./sounds/chime-1.wav"
import chime2Sound from "./sounds/chime-2.wav"
import chime3Sound from "./sounds/chime-3.wav"
import chime4Sound from "./sounds/chime-4.wav"
import chime5Sound from "./sounds/chime-5.wav"
import chime6Sound from "./sounds/chime-6.wav"
import chime7Sound from "./sounds/chime-7.wav"
import chime8Sound from "./sounds/chime-8.wav"
import codec1Sound from "./sounds/codec-1.wav"
import codec2Sound from "./sounds/codec-2.wav"
import currencySound from "./sounds/currency.wav"
import enterSound from "./sounds/enter.wav"
import enterCombatSound from "./sounds/enter-combat.wav"
import impact1Sound from "./sounds/impact-1.wav"
import impact2Sound from "./sounds/impact-2.wav"
import impact3Sound from "./sounds/impact-3.wav"
import impact4Sound from "./sounds/impact-4.wav"
import messageSound from "./sounds/message.wav"
import textSound from "./sounds/text.wav"
import themeSound from "./sounds/theme.mp3"
import warpSound from "./sounds/warp.wav"
// Videos
import planetLoadingVideo from "./videos/planet-loader.mp4"
import titleVideo from "./videos/title.mp4"

export const images = {
  splash1,
  character1,
  character2,
  aegisCruiserLogo,
  atlasHaulerLogo,
  autonomousLightHaulerLogo,
  autonomousProbeLogo,
  bulwarkDestroyerLogo,
  corsairRaiderLogo,
  kestrelLogo,
  pikeFrigateLogo,
  pioneerLifterLogo,
  sovereignStarcruiserLogo,
  sparrowScoutLogo,
  wayfarerFreighterLogo,
  escapePodLogo,
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
  enter: enterSound,
  enterCombat: enterCombatSound,
  message: messageSound,
  chime1: chime1Sound,
  chime2: chime2Sound,
  chime3: chime3Sound,
  chime4: chime4Sound,
  chime5: chime5Sound,
  chime6: chime6Sound,
  chime7: chime7Sound,
  chime8: chime8Sound,
  impact1: impact1Sound,
  impact2: impact2Sound,
  impact3: impact3Sound,
  impact4: impact4Sound,
  text: textSound,
  currency: currencySound,
  codec1: codec1Sound,
  codec2: codec2Sound,
  theme: themeSound,
  warp: warpSound,
} as const

// JS Chunks - preload lazy-loaded components and their dependencies
export const chunks = {
  starfield: () => import("@/components/StarfieldLazy"),
} as const
