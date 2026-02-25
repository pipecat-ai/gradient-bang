import { images } from "@/assets"

export const SHIP_LOGO_IMAGE_MAP = {
  aegis_cruiser: images.aegisCruiserLogo,
  atlas_hauler: images.atlasHaulerLogo,
  autonomous_light_hauler: images.autonomousLightHaulerLogo,
  autonomous_probe: images.autonomousProbeLogo,
  bulwark_destroyer: images.bulwarkDestroyerLogo,
  corsair_raider: images.corsairRaiderLogo,
  kestrel_courier: images.kestrelLogo,
  pike_frigate: images.pikeFrigateLogo,
  pioneer_lifter: images.pioneerLifterLogo,
  sovereign_starcruiser: images.sovereignStarcruiserLogo,
  sparrow_scout: images.sparrowScoutLogo,
  wayfarer_freighter: images.wayfarerFreighterLogo,
  escape_pod: images.escapePodLogo,
}

export const getShipLogoImage = (shipType: string) => {
  return SHIP_LOGO_IMAGE_MAP[shipType as keyof typeof SHIP_LOGO_IMAGE_MAP]
}
