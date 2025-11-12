import useGameStore from "@/stores/game";
import { Button } from "../primitives/Button";

export const Center = () => {
  const setActiveModal = useGameStore.use.setActiveModal();
  return (
    <div className="flex flex-col gap-2 bg-red-500">
      <Button
        size="icon"
        onClick={() => {
          setActiveModal("settings");
        }}
      >
        s
      </Button>
    </div>
  );
};
