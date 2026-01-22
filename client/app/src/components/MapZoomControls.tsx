import { useState } from 'react';

import { useDebouncedCallback } from 'use-debounce';
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react';

import useGameStore from "@/stores/game";

import { Button } from "./primitives/Button";
import { SliderControl } from './primitives/SliderControl';

export const MapZoomControls = () => {
    const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
    const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()
    const [sliderValue, setSliderValue] = useState(mapZoomLevel);

    const debounced = useDebouncedCallback(
        (value) => {
            setMapZoomLevel(value);
        }, 200, { leading: true }
    );

    const debouncedTrailing = useDebouncedCallback(
        (value) => {
            setMapZoomLevel(value);
        }, 500, { trailing: true }
    );

    return (
        <div className="absolute top-0 right-0 flex flex-row gap-2">

            <Button size="icon-sm" onClick={() => {
                debounced(mapZoomLevel - 5);
            }}><MagnifyingGlassPlusIcon weight="bold" /></Button>
            <SliderControl
                value={[sliderValue]}
                min={1}
                max={50}
                step={1}
                onValueChange={(value) => {
                    setSliderValue(value[0]);
                    debouncedTrailing(value[0]);
                }}
                className="w-24"
            />
            <Button size="icon-sm" onClick={() => {
                debounced(mapZoomLevel + 5);
            }}><MagnifyingGlassMinusIcon weight="bold" /></Button>
        </div>
    )
}