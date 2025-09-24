import useGameStore from "../stores/game";

export const SectorMap = () => {
  const sectors = useGameStore.use.sectors();

  console.log("Sector Map:", sectors);

  return <div>SectorMap</div>;
};
