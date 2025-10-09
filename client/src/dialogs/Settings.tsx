import { SettingsPanel } from "@/components/SettingsPanel";
import useGameStore from "@/stores/game";
import {
  Card,
  CardHeader,
  CardTitle,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { Dialog } from "radix-ui";

export const Settings = () => {
  const setModal = useGameStore.use.setModal();
  const modal = useGameStore.use.ui().modal;

  const handleSave = () => {
    setModal(undefined);
  };

  return (
    <Dialog.Root
      open={modal === "settings"}
      onOpenChange={() => setModal(undefined)}
    >
      <Dialog.Portal>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Overlay className="DialogOverlay animate-in fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="DialogContent min-w-md bg-black/50"
        >
          <Card
            size="xl"
            background="scanlines"
            withElbows={true}
            className="w-full animate-in fade-in-0 zoom-in origin-center"
          >
            <CardHeader>
              <CardTitle>
                <PanelTitle>Settings</PanelTitle>
              </CardTitle>
            </CardHeader>
            <SettingsPanel onSave={handleSave} />
          </Card>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
