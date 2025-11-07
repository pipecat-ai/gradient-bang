// Images
export const images = {
  skybox1: new URL("./images/skybox-1.png", import.meta.url).href,
  skybox2: new URL("./images/skybox-2.png", import.meta.url).href,
  skybox3: new URL("./images/skybox-3.png", import.meta.url).href,
  skybox4: new URL("./images/skybox-4.png", import.meta.url).href,
  skybox5: new URL("./images/skybox-5.png", import.meta.url).href,
  skybox6: new URL("./images/skybox-6.png", import.meta.url).href,
  skybox7: new URL("./images/skybox-7.png", import.meta.url).href,
  skybox8: new URL("./images/skybox-8.png", import.meta.url).href,
  skybox9: new URL("./images/skybox-9.png", import.meta.url).href,
} as const;

// Videos
export const videos = {
  title: new URL("./videos/title.mp4", import.meta.url).href,
} as const;

// Sounds
export const sounds = {
  warp: new URL("./sounds/warp.wav", import.meta.url).href,
  start: new URL("./sounds/start.wav", import.meta.url).href,
  message: new URL("./sounds/message.wav", import.meta.url).href,
  chime1: new URL("./sounds/chime-1.wav", import.meta.url).href,
  chime2: new URL("./sounds/chime-2.wav", import.meta.url).href,
  chime3: new URL("./sounds/chime-3.wav", import.meta.url).href,
  chime4: new URL("./sounds/chime-4.wav", import.meta.url).href,
  chime5: new URL("./sounds/chime-5.wav", import.meta.url).href,
  chime6: new URL("./sounds/chime-6.wav", import.meta.url).href,
  text: new URL("./sounds/text.wav", import.meta.url).href,
  ambience: new URL("./sounds/ambience.wav", import.meta.url).href,
} as const;

// JS Chunks
export const chunks = {
  starfield: () => import("@/fx/starfield"),
} as const;
