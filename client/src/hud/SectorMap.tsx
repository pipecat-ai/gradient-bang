import useGameStore from "@/stores/game";

interface SectorMapConfig {
  colors: {
    empty: string;
    port: string;
    mega_port: string;
  };
  show_grid: boolean;
  show_regions: boolean;
  show_warps: boolean;
  show_sector_ids: boolean;
  show_ports: boolean;
  show_hyperlanes: boolean;
  current_sector: Sector | null;
  current_region: string;
}

export const SectorMap = () => {
  const sectors = useGameStore.use.sectors();

  console.log(sectors);

  return <div className="w-full h-full bg-black/80"></div>;
};

export default SectorMap;
