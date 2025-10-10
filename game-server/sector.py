"""
Starfield Scene Generator
Generates random scene configurations compatible with the TypeScript SceneManager
"""

import json
import copy
import random
from dataclasses import dataclass, asdict
from typing import Optional, Dict, Any


@dataclass
class RGBColor:
    """RGB color with float values (0.0-1.0)"""
    r: float
    g: float
    b: float


@dataclass
class NebulaPalette:
    """Nebula color palette definition"""
    name: str
    c1: RGBColor
    c2: RGBColor
    mid: RGBColor


@dataclass
class StarfieldSceneConfig:
    """Scene-specific configuration (properties that vary per scene)"""
    nebulaColor1: Optional[RGBColor] = None
    nebulaColor2: Optional[RGBColor] = None
    nebulaColorMid: Optional[RGBColor] = None
    nebulaIntensity: Optional[float] = None
    nebulaDarkLaneStrength: Optional[float] = None
    nebulaDomainWarpStrength: Optional[float] = None
    nebulaIdleNoiseSpeed: Optional[float] = None
    nebulaAnisotropy: Optional[float] = None
    nebulaFilamentContrast: Optional[float] = None
    cloudsIntensity: Optional[float] = None
    cloudsColorPrimary: Optional[RGBColor] = None
    cloudsColorSecondary: Optional[RGBColor] = None
    cloudsIterPrimary: Optional[int] = None
    cloudsIterSecondary: Optional[int] = None
    cloudsDomainScale: Optional[float] = None
    cloudsSpeed: Optional[float] = None
    planetImageUrl: Optional[str] = None
    planetScale: Optional[float] = None
    planetPositionX: Optional[float] = None
    planetPositionY: Optional[float] = None
    starSize: Optional[float] = None


NEBULA_PALETTES = [
    NebulaPalette("tealOrange", RGBColor(0.1, 0.65, 0.7), RGBColor(0.98, 0.58, 0.2), RGBColor(0.8, 0.75, 0.65)),
    NebulaPalette("magentaGreen", RGBColor(0.75, 0.15, 0.75), RGBColor(0.2, 0.85, 0.45), RGBColor(0.6, 0.55, 0.7)),
    NebulaPalette("blueGold", RGBColor(0.15, 0.35, 0.95), RGBColor(0.95, 0.78, 0.25), RGBColor(0.7, 0.72, 0.8)),
    NebulaPalette("cyanRed", RGBColor(0.1, 0.85, 0.9), RGBColor(0.9, 0.2, 0.25), RGBColor(0.75, 0.65, 0.7)),
    NebulaPalette("violetAmber", RGBColor(0.55, 0.25, 0.85), RGBColor(0.98, 0.7, 0.2), RGBColor(0.8, 0.7, 0.85)),
    NebulaPalette("emeraldRose", RGBColor(0.1, 0.75, 0.5), RGBColor(0.95, 0.45, 0.6), RGBColor(0.7, 0.75, 0.75)),
    NebulaPalette("indigoPeach", RGBColor(0.2, 0.25, 0.7), RGBColor(1.0, 0.7, 0.55), RGBColor(0.75, 0.7, 0.8)),
    NebulaPalette("mintCoral", RGBColor(0.5, 0.95, 0.8), RGBColor(1.0, 0.45, 0.45), RGBColor(0.85, 0.8, 0.8)),
]

PLANET_IMAGES = [
    "/images/skybox-1.png", "/images/skybox-2.png", "/images/skybox-3.png",
    "/images/skybox-4.png", "/images/skybox-5.png", "/images/skybox-6.png",
    "/images/skybox-7.png", "/images/skybox-8.png", "/images/skybox-9.png",
]


# Example scene to test with
DEFAULT_SCENE_VARIANT = StarfieldSceneConfig(
    starSize=0.8598574083303371,
    nebulaColor1=RGBColor(0.1, 0.65, 0.7),
    nebulaColor2=RGBColor(0.98, 0.58, 0.2),
    nebulaColorMid=RGBColor(0.8, 0.75, 0.65),
    nebulaIntensity=0.6199235186484485,
    nebulaIdleNoiseSpeed=0.10912665296459649,
    nebulaAnisotropy=1.565764620751131,
    nebulaDomainWarpStrength=0.25317018822824133,
    nebulaFilamentContrast=0.8204679874699949,
    nebulaDarkLaneStrength=0.3550203974779636,
    cloudsIntensity=0.6455095224322042,
    cloudsColorPrimary=RGBColor(0.1, 0.65, 0.7),
    cloudsColorSecondary=RGBColor(0.98, 0.58, 0.2),
    cloudsIterPrimary=23,
    cloudsIterSecondary=5,
    cloudsDomainScale=1.1171601050299351,
    cloudsSpeed=0.0018857592386780921,
    planetImageUrl="/images/skybox-5.png",
    planetScale=2.455725807687239,
    planetPositionX=-108.8674861508628,
    planetPositionY=-19.475426289700927,
)


def generate_scene_variant(sector_id: int, overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Generate a random starfield scene configuration.
    Mirrors the TypeScript SceneManager.createVariant() logic.
    
    Args:
        sector_id: Sector number (used to seed randomization for consistent scenes)
        overrides: Optional dict of properties to override random values
        
    Returns:
        Dictionary compatible with TypeScript StarfieldSceneConfig
    """
    if sector_id == 0:
        config = copy.deepcopy(DEFAULT_SCENE_VARIANT)
        if overrides:
            for key, value in overrides.items():
                if hasattr(config, key):
                    setattr(config, key, value)
        result = asdict(config)
        return {k: v for k, v in result.items() if v is not None}

    rng = random.Random(sector_id)
    random_nebula = rng.choice(NEBULA_PALETTES)
    random_planet = rng.choice(PLANET_IMAGES)
    
    config = StarfieldSceneConfig(
        nebulaColor1=random_nebula.c1,
        nebulaColor2=random_nebula.c2,
        nebulaColorMid=random_nebula.mid,
        nebulaIntensity=rng.uniform(0.15, 2.15),
        nebulaDarkLaneStrength=rng.uniform(0.35, 1.0),
        nebulaDomainWarpStrength=rng.uniform(0.05, 0.35),
        nebulaIdleNoiseSpeed=rng.uniform(0.02, 0.17),
        nebulaAnisotropy=rng.uniform(1.0, 3.5),
        nebulaFilamentContrast=rng.uniform(0.2, 1.0),
        cloudsIntensity=rng.uniform(0.22, 0.87),
        cloudsColorPrimary=random_nebula.c1,
        cloudsColorSecondary=random_nebula.c2,
        cloudsIterPrimary=rng.randint(10, 29),
        cloudsIterSecondary=rng.randint(1, 10),
        cloudsDomainScale=rng.uniform(0.5, 1.49),
        cloudsSpeed=rng.uniform(0.001, 0.006),
        planetImageUrl=random_planet,
        planetScale=rng.uniform(2.0, 6.0),
        planetPositionX=(rng.random() - 0.5) * 400,
        planetPositionY=(rng.random() - 0.5) * 400,
        starSize=rng.uniform(0.75, 1.25),
    )
    
    # Apply overrides if provided
    if overrides:
        for key, value in overrides.items():
            if hasattr(config, key):
                setattr(config, key, value)
    
    # Convert to dict and remove None values
    result = asdict(config)
    return {k: v for k, v in result.items() if v is not None}