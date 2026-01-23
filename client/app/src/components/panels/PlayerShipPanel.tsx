import { CircleNotchIcon } from "@phosphor-icons/react";

import { useDispatchInterval } from "@/hooks/useDispatchInterval";
import useGameStore from "@/stores/game";

import { PopoverHelper } from "../PopoverHelper";

const SHIP_HYDRATION_INTERVAL = 3000;
const SHIP_HYDRATION_STALE_TIME = 10000;

const ShipBlankSlate = ({ fetching, empty, children }: { fetching?: boolean, empty?: boolean, children?: React.ReactNode }) => {
    return (
        <div className="bg-[linear-gradient(to_right,transparent_0%,var(--subtle-background)_20%,var(--subtle-background)_80%,transparent_100%)] text-subtle-foreground text-xs uppercase font-medium leading-none py-2">
            <div className="flex flex-row gap-3 items-center justify-center">
                <div className="flex-1 dotted-bg-sm text-subtle h-3"></div>
                <div className="flex flex-row gap-2 items-center justify-center">
                    {fetching ?
                        <span className="animate-pulse flex flex-row gap-2 items-center justify-center"><CircleNotchIcon weight="bold" className="shrink-0 size-3 animate-spin" />Fetching ships...</span>
                        : empty ? <span className="flex flex-row gap-2 items-center justify-center">Not connected</span>
                            : children}
                </div>
                <div className="flex-1 dotted-bg-sm text-subtle h-3"></div>
            </div>
        </div>
    );
};

export const PlayerShipPanel = () => {
    const shipsState = useGameStore((state) => state.ships);

    const { isFetching } = useDispatchInterval("get-my-ships", {
        data: shipsState.data,
        interval: SHIP_HYDRATION_INTERVAL,
        staleTime: SHIP_HYDRATION_STALE_TIME,
        lastUpdated: shipsState.last_updated,
        debug: false,
    });

    const ships = shipsState.data;

    // Loading state
    if (!ships || isFetching) {
        return (<ShipBlankSlate fetching={isFetching} empty={ships === undefined} />
        );
    }

    // Empty state (no corporation ships)
    if (ships.filter((ship) => ship.owner_type === "corporation").length === 0) {
        return <ShipBlankSlate>
            <span className="flex flex-row gap-2 items-center justify-center">
                No corporation ships <PopoverHelper className="text-subtle-foreground" />
            </span>
        </ShipBlankSlate>;
    }

    return (
        <div>
            <div className="flex flex-col gap-2">
                {ships.filter((ship) => ship.owner_type === "corporation").map((ship) => (
                    <div key={ship.ship_id}>Ship:{ship.ship_type}</div>
                ))}
            </div>
        </div>
    );
};
