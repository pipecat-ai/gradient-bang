import Splash from "@/assets/images/splash-1.png"

export const Starfield = () => {
  return (
    <div className="absolute h-full inset-0 overflow-hidden bg-black z-(--z-starfield)">
      <img
        src={Splash}
        alt="Splash"
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      />
    </div>
  )
}
