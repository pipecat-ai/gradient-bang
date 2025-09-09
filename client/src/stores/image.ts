import { create } from "zustand";

import PortImageSSB from "../images/ports/SSB.png";

const portImageMap = {
  SSB: PortImageSSB,
  BSB: PortImageSSB,
};

interface ImageState {
  image: string | undefined;
  setImage: (image: string) => void;
  getImage: () => string | undefined;
  getPortImage: (code: string) => string | undefined;
  clearImage: () => void;
}

const useImageStore = create<ImageState>((set, get) => ({
  image: undefined,
  setImage: (image: string) => set({ image }),
  getImage: () => get().image,
  getPortImage: (code: string) =>
    portImageMap[code as keyof typeof portImageMap],
  clearImage: () => set({ image: undefined }),
}));

export default useImageStore;
