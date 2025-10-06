import MiniMap from "@/hud/MiniMap";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";

export const Init: Story = () => {
  const player = useGameStore((state) => state.player);
  const ship = useGameStore((state) => state.ship);
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);

  return (
    <>
      <p className="story-description">
        We expect to receive a full status hydration from the server on connect,
        and local map data.
      </p>
      <div className="story-card">
        <h3 className="story-heading">Player:</h3>
        {player && (
          <ul className="story-value-list">
            {Object.entries(player).map(([key, value]) => (
              <li key={key}>
                <span>{key}</span> <span>{value?.toString()}</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="story-heading">Ship:</h3>
        {ship && (
          <ul className="story-value-list">
            {Object.entries(ship).map(([key, value]) => (
              <li key={key}>
                <span className="flex-1">{key}</span>
                <span className="flex-1">
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : value.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="story-heading">Sector:</h3>
        {sector && (
          <ul className="story-value-list">
            {Object.entries(sector).map(([key, value]) => (
              <li key={key}>
                <span className="flex-1">{key}</span>
                <span className="flex-1">
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : value.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="story-card  bg-card">
          <h3 className="story-heading">Local Area Map:</h3>
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector.id}
              map_data={localMapData}
              width={440}
              height={440}
              maxDistance={3}
            />
          )}
        </div>
      </div>
    </>
  );
};

Init.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [["Fetch current status", "Tell me my current status."]],
};

export const Settings: Story = () => {
  const settings = useGameStore.use.settings();

  return (
    <>
      <p className="story-description">
        Story shows the client's current settings. This is derived from the
        store defaults, and any overrides defined in `settings.json` file.
      </p>
      <ul className="story-value-list">
        {Object.entries(settings).map(([key, value]) => (
          <li key={key}>
            <span>{key}</span> <span>{value.toString()}</span>
          </li>
        ))}
      </ul>
    </>
  );
};

Settings.meta = {
  disconnectedStory: true,
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
};
