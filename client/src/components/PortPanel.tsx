import { LightningIcon, NutIcon, PlantIcon } from "@phosphor-icons/react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  Divider,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { useEffect } from "react";
import { usePanelRef } from "../hooks/usePanelRef";
import useImageStore from "../stores/image";
import usePortStore from "../stores/port";

const IconMap = {
  ro: <PlantIcon size={28} weight="duotone" />,
  qf: <NutIcon size={28} weight="duotone" />,
  ns: <LightningIcon size={28} weight="duotone" />,
};

const codeToLabel = {
  ro: "Retro-organics",
  qf: "Quantum Foam",
  ns: "Neuro-symbolics",
};

const codeToAbbrev = {
  ro: "RO",
  qf: "QF",
  ns: "NS",
};

const baseClx = "flex flex-col gap-4";
const inactiveClx = "opacity-50";

const CommodityItem = ({
  commodity,
  sells = false,
  buys = false,
  price = 0,
  units = 0,
}: {
  commodity: "ro" | "qf" | "ns";
  sells?: boolean;
  buys?: boolean;
  price?: number;
  units?: number;
}) => {
  return (
    <Card className={`${baseClx} ${!buys && !sells ? inactiveClx : ""}`}>
      <CardHeader className="flex flex-col gap-2">
        <div className={buys || sells ? "text-agent" : ""}>
          {IconMap[commodity as keyof typeof IconMap]}
        </div>

        <PanelTitle>
          {codeToLabel[commodity as keyof typeof codeToLabel]}{" "}
          <span className="opacity-40">
            ({codeToAbbrev[commodity as keyof typeof codeToAbbrev]})
          </span>
        </PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Badge
            size="md"
            variant="elbow"
            className={`w-full justify-between ${sells ? "" : "opacity-40"}`}
          >
            <span className="opacity-40">Stock:</span>
            {sells ? units : "---"}
          </Badge>
          <Badge
            size="md"
            variant="elbow"
            className={`w-full justify-between ${sells ? "" : "opacity-40"}`}
          >
            <span className="opacity-40">$ per unit:</span>
            {sells ? price.toLocaleString() : "---"}
          </Badge>
        </div>
        <Divider variant="dotted" className="h-2" />
        <Badge
          size="md"
          variant="elbow"
          color={buys ? "active" : "ghost"}
          className={`w-full ${buys ? "animate-pulse" : "opacity-40"}`}
        >
          {buys ? "Buying" : "Does not buy"}
        </Badge>
      </CardContent>
    </Card>
  );
};

export const PortPanel = () => {
  const { active, port } = usePortStore();
  const { setImage, getPortImage, clearImage } = useImageStore();
  const panelRef = usePanelRef("port");

  useEffect(() => {
    if (!port || !active) {
      clearImage();
      return;
    }

    setImage(getPortImage(port.code) || "");
  }, [port, active, setImage, getPortImage, clearImage]);

  if (!active) return null;

  const buysQF = port?.code?.split("")[0] === "B";
  const buysRO = port?.code?.split("")[1] === "B";
  const buysNS = port?.code?.split("")[2] === "B";
  const sellsQF = port?.code?.split("")[0] === "S";
  const sellsRO = port?.code?.split("")[1] === "S";
  const sellsNS = port?.code?.split("")[2] === "S";

  return (
    <div className="absolute -left-5 bg-background">
      <Card ref={panelRef} className="flex" background="stripes" size="md">
        <CardContent className="flex flex-col overflow-y-auto">
          <h1 className="text-xl font-extrabold">
            Tradepost<span className="opacity-40"> / </span>
            {port?.code || "BSB"}
          </h1>
          <Divider decoration="plus" size="md" />
          <div className="flex flex-row gap-2">
            <CommodityItem
              commodity="qf"
              buys={buysQF}
              sells={sellsQF}
              price={port?.last_seen_prices.quantum_foam || 0}
              units={port?.last_seen_stock.quantum_foam || 0}
            />
            <CommodityItem
              commodity="ro"
              buys={buysRO}
              sells={sellsRO}
              price={port?.last_seen_prices.retro_organics || 0}
              units={port?.last_seen_stock.retro_organics || 0}
            />
            <CommodityItem
              commodity="ns"
              sells={sellsNS}
              buys={buysNS}
              price={port?.last_seen_prices.neuro_symbolics || 0}
              units={port?.last_seen_stock.neuro_symbolics || 0}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
