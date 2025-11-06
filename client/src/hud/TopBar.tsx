import { ScreenMenu } from "@/screens/ScreenMenu";
//import useGameStore from "@stores/game";

export const TopBar = () => {
  //const player = useGameStore.use.player();
  //const setActiveModal = useGameStore.use.setActiveModal();

  return (
    <header className="flex flex-row justify-between items-center px-ui-md">
      <div className="flex flex-row gap-4 flex-1"></div>
      <div className="flex flex-row gap-2 items-center">
        <ScreenMenu />
      </div>
      <div className="flex flex-row gap-4 flex-1 justify-end">
        {/*<Button
          isIcon
          variant="outline"
          onClick={() => setActiveModal("settings")}
        >
          <SlidersHorizontalIcon className="size-5" />
        </Button>*/}
      </div>
    </header>
  );
};
