import { Button } from "@/components/primitives/Button";
import { ToastContainer } from "@/components/toasts/ToastContainer";
import useGameStore from "@/stores/game";

export const ToastsStory = () => {
  const addToast = useGameStore.use.addToast();
  const clearToasts = useGameStore.use.clearToasts();

  return (
    <div className="relative w-full h-screen p-8">
      <ToastContainer />
      <div className="flex flex-col gap-4">
        <Button
          onClick={() =>
            addToast({
              type: "fuel_purchased",
              meta: { amount: 100 },
            })
          }
        >
          Add Fuel Purchased Toast
        </Button>
        <Button
          onClick={() =>
            addToast({
              type: "currency_change",
              meta: {
                amount: 5000,
                newBalance: 25000,
              },
            })
          }
        >
          Add Currency Toast
        </Button>
        <Button
          onClick={() =>
            addToast({
              type: "fuel_transfer",
              meta: {
                amount: 150,
                direction: "received",
              },
            })
          }
        >
          Add Fuel Toast
        </Button>
        <Button
          onClick={() =>
            addToast({
              type: "trade_executed",
              meta: {
                commodity: "Quantum Foam",
                quantity: 100,
                credits: 12000,
                tradeType: "buy",
              },
            })
          }
        >
          Add Trade Toast
        </Button>
        <Button
          onClick={() =>
            addToast({
              type: "warp_purchase",
              meta: {
                cost: 250,
                sectorName: "Alpha Centauri",
              },
            })
          }
        >
          Add Warp Toast
        </Button>
        <Button onClick={() => clearToasts()}>Clear All Toasts</Button>
      </div>
    </div>
  );
};

ToastsStory.meta = {
  disconnectedStory: true,
};
