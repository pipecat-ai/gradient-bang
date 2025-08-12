import { useEffect, useRef } from "react";
import type { PanelId } from "../UIContext";
import { useUI } from "./useUI";

export const usePanelRef = <T extends HTMLElement = HTMLDivElement>(
  panelId: PanelId
) => {
  const { registerPanelRef } = useUI();
  const ref = useRef<T>(null);

  useEffect(() => {
    registerPanelRef(panelId, ref.current);
  }, [panelId, registerPanelRef]);

  return ref;
};
