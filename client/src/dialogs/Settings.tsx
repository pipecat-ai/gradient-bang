import { Card } from "@/components/primitives/Card";
import { SettingsPanel } from "@/components/SettingsPanel";
import useGameStore from "@/stores/game";
import { Dialog } from "radix-ui";

export const Settings = () => {
  const setActiveModal = useGameStore.use.setActiveModal();
  const activeModal = useGameStore.use.activeModal?.();

  const handleSave = () => {
    setActiveModal(undefined);
  };

  return (
    <Dialog.Root
      open={activeModal === "settings"}
      onOpenChange={() => setActiveModal(undefined)}
    >
      <Dialog.Portal>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Overlay className="DialogOverlay bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center animate-in fade-in-0 duration-300">
          <Dialog.Content
            aria-describedby={undefined}
            className="DialogContent max-w-xl"
          >
            <Card
              elbow={true}
              size="default"
              className="w-full h-full max-h-max bg-black animate-in fade-in-0 zoom-in origin-center shadow-2xl"
            >
              <SettingsPanel
                onSave={handleSave}
                onCancel={() => setActiveModal(undefined)}
              />
            </Card>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
