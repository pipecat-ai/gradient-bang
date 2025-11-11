import { SalvageCollectedToast } from "@/components/toasts/SalvageCollectedToast";

export const ToastsStory = () => {
  return (
    <div className="relative w-full p-8 h-toast">
      <div className=" p-ui-xs">
        <SalvageCollectedToast
          toast={{
            type: "salvage.collected",
            meta: {
              salvage: {
                salvage_id: "salv_123",
              },
            },
          }}
          onAnimateIn={() => {}}
          onAnimationComplete={() => {}}
          onDismiss={() => {}}
        />
      </div>
    </div>
  );
};

ToastsStory.meta = {
  disconnectedStory: true,
};
