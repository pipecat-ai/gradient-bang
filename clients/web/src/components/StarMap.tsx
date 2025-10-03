import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

interface Sector {
  id: number;
  x: number;
  y: number;
  z: number;
  type: "empty" | "port" | "terra";
  warps_out: number[];
  warps_in: number[];
  info?: any;
  name: string;
}

interface StarMapProps {
  layoutData?: any;
  sectorData?: any;
  onSectorSelect?: (sector: Sector) => void;
  selectedSector?: Sector | null;
  plotMode?: boolean;
  originSector?: Sector | null;
}

const StarMap: React.FC<StarMapProps> = ({
  layoutData,
  sectorData,
  onSectorSelect,
  selectedSector,
  plotMode = false,
  originSector = null,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rotationGroupRef = useRef<THREE.Group | null>(null);

  const [sectors, setSectors] = useState<Record<number, Sector>>({});
  const [sectorMeshes, setSectorMeshes] = useState<Record<number, THREE.Mesh>>(
    {}
  );
  const [sectorLabels, setSectorLabels] = useState<
    Record<number, THREE.Sprite>
  >({});
  const [animatedLines, setAnimatedLines] = useState<any[]>([]);
  const [warpLineMap, setWarpLineMap] = useState<Record<number, any[]>>({});

  const [mouseX, setMouseX] = useState(0);
  const [mouseY, setMouseY] = useState(0);
  const [tRotX, setTRotX] = useState(0);
  const [tRotY, setTRotY] = useState(0);
  const [mouseDown, setMouseDown] = useState(false);
  const [hoveredSector, setHoveredSector] = useState<Sector | null>(null);

  // Materials and geometries
  const matSector = new THREE.MeshPhongMaterial({
    color: 0x00ff00,
    emissive: 0x002200,
    shininess: 100,
  });

  const matPort = new THREE.MeshPhongMaterial({
    color: 0x00ffff,
    emissive: 0x002222,
    shininess: 100,
  });

  const matTerra = new THREE.MeshPhongMaterial({
    color: 0xffff00,
    emissive: 0x222200,
    shininess: 100,
  });

  const geoSector = new THREE.SphereGeometry(0.6, 16, 16);
  const geoPort = new THREE.OctahedronGeometry(0.8);
  const geoTerra = new THREE.IcosahedronGeometry(1.1);

  const lineMaterialTwoWay = new THREE.LineBasicMaterial({
    color: 0x00ffff,
    opacity: 0.35,
    transparent: true,
  });

  const lineMaterialOneWay = new THREE.LineBasicMaterial({
    color: 0x1266ff,
    opacity: 0.5,
    transparent: true,
  });

  const coneGeo = new THREE.ConeGeometry(0.35, 1.0, 10);
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x1266ff });

  // Utility functions
  const mulberry32 = (a: number) => {
    return function () {
      var t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const seededPosition = (seed: number, id: number, radius = 100) => {
    const rng = mulberry32((seed | 0) + (id | 0) * 2654435761);
    const u = rng();
    const v = rng();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.6 + 0.4 * rng());
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    return { x, y, z };
  };

  const makeLabel = (text: string, color = "#00ff00") => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    canvas.width = 512;
    canvas.height = 80;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "28px monospace";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(text, 256, 48);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.85,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(12, 2, 1);
    return sprite;
  };

  // AnimatedLine class
  class AnimatedLine {
    line: THREE.Line;
    arrow?: THREE.Mesh;
    directed: boolean;
    isRoute: boolean;
    material: THREE.LineBasicMaterial;
    geometry: THREE.BufferGeometry;
    start: THREE.Vector3;
    end: THREE.Vector3;
    animationOffset: number;
    isAnimating: boolean;

    constructor(start: THREE.Vector3, end: THREE.Vector3, opts: any) {
      const { material, directed = false, route = false } = opts;
      this.directed = directed;
      this.isRoute = route;
      this.material = (material || lineMaterialTwoWay).clone();
      const points = [start.clone(), end.clone()];
      this.geometry = new THREE.BufferGeometry().setFromPoints(points);
      this.line = new THREE.Line(this.geometry, this.material);
      this.start = start.clone();
      this.end = end.clone();
      this.animationOffset = Math.random() * Math.PI * 2;
      this.isAnimating = true;

      if (directed) {
        this.arrow = new THREE.Mesh(coneGeo, coneMat.clone());
        this.arrowPosFromTo(start, end);
        this.arrow.matrixAutoUpdate = true;
      }
    }

    arrowPosFromTo(a: THREE.Vector3, b: THREE.Vector3) {
      if (!this.arrow) return;
      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      const pos = new THREE.Vector3().copy(b).addScaledVector(dir, -0.8);
      this.arrow.position.copy(pos);
      const axis = new THREE.Vector3(0, 1, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(axis, dir);
      this.arrow.setRotationFromQuaternion(quat);
    }

    setHighlighted(on: boolean, asRoute = false) {
      if (asRoute) {
        this.material.color.setHex(0xff00ff);
        this.material.opacity = 0.8;
        if (this.arrow) this.arrow.material.color.setHex(0xff00ff);
      } else if (on) {
        this.material.opacity = 1.0;
        if (this.directed) {
          this.material.color.setHex(0x3aa0ff);
          if (this.arrow) this.arrow.material.color.setHex(0x3aa0ff);
        } else {
          this.material.color.setHex(0x00ffff);
        }
      } else {
        if (this.directed) {
          this.material.color.setHex(0x1266ff);
          this.material.opacity = 0.5;
          if (this.arrow) this.arrow.material.color.setHex(0x1266ff);
        } else {
          this.material.color.setHex(0x00ffff);
          this.material.opacity = 0.35;
        }
      }
      this.isRoute = asRoute;
    }

    setVisible(v: boolean) {
      this.line.visible = v;
      if (this.arrow) this.arrow.visible = v;
    }

    dispose() {
      this.geometry.dispose();
      if (this.arrow) {
        this.arrow.geometry.dispose();
      }
    }

    update(time: number) {
      const pulse = (Math.sin(time * 0.001 + this.animationOffset) + 1) * 0.5;
      if (!this.isRoute) {
        const base = this.directed ? 0.45 : 0.3;
        this.material.opacity = base + 0.4 * pulse;
      }
    }
  }

  // Initialize Three.js scene
  const initScene = useCallback(() => {
    if (!mountRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    camera.position.z = 100;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    mountRef.current.appendChild(renderer.domElement);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0x404040);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Create rotation group
    const rotationGroup = new THREE.Group();
    scene.add(rotationGroup);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    rotationGroupRef.current = rotationGroup;

    // Animation loop
    const animate = () => {
      requestAnimationFrame(animate);
      const time = Date.now();

      if (rotationGroupRef.current) {
        rotationGroupRef.current.rotation.x +=
          (tRotX - rotationGroupRef.current.rotation.x) * 0.05;
        rotationGroupRef.current.rotation.y +=
          (tRotY - rotationGroupRef.current.rotation.y) * 0.05;
      }

      animatedLines.forEach((l) => l.update(time));

      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    // Handle window resize
    const handleResize = () => {
      if (cameraRef.current && rendererRef.current) {
        cameraRef.current.aspect = window.innerWidth / window.innerHeight;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(window.innerWidth, window.innerHeight);
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (mountRef.current && rendererRef.current) {
        mountRef.current.removeChild(rendererRef.current.domElement);
      }
    };
  }, [tRotX, tRotY, animatedLines]);

  // Build sectors from data
  const buildFromJson = useCallback(
    (layout: any, info: any) => {
      if (!rotationGroupRef.current) return;

      // Clear existing scene
      Object.values(sectorMeshes).forEach((m) =>
        rotationGroupRef.current!.remove(m)
      );
      Object.values(sectorLabels).forEach((l) =>
        rotationGroupRef.current!.remove(l)
      );
      animatedLines.forEach((l) => {
        rotationGroupRef.current!.remove(l.line);
        if (l.arrow) rotationGroupRef.current!.remove(l.arrow);
        l.dispose();
      });

      const newSectors: Record<number, Sector> = {};
      const newSectorMeshes: Record<number, THREE.Mesh> = {};
      const newSectorLabels: Record<number, THREE.Sprite> = {};
      const newAnimatedLines: any[] = [];
      const newWarpLineMap: Record<number, any[]> = {};

      const meta = layout.meta || {};
      const seed = meta.seed || 1234;
      const idBase = meta.id_base != null ? meta.id_base : 0;
      const infoMap = new Map();

      if (info && Array.isArray(info.sectors)) {
        for (const s of info.sectors) infoMap.set(String(s.id), s);
      }

      // Create sectors
      for (const s of layout.sectors || []) {
        const id = s.id;
        const pos = seededPosition(seed, id);
        const extra = infoMap.get(String(id));
        let type: "empty" | "port" | "terra" = "empty";
        if (extra && extra.port) type = "port";
        if (id === 1 || id === idBase)
          type = type === "port" ? "port" : "terra";

        newSectors[id] = {
          id,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          type,
          warps_out: [],
          warps_in: [],
          info: extra || null,
          name: `Sector ${id}`,
        };
      }

      // Create warps
      const seenUndirected = new Set();
      const addWarp = (from: number, to: number) => {
        if (newSectors[from]) newSectors[from].warps_out.push(to);
        if (newSectors[to]) newSectors[to].warps_in.push(from);
      };

      for (const s of layout.sectors || []) {
        const from = s.id;
        for (const w of s.warps || []) {
          const to = w.to;
          const isTwoWay = !!w.two_way;
          addWarp(from, to);
          if (isTwoWay) addWarp(to, from);

          const a = new THREE.Vector3(
            newSectors[from].x,
            newSectors[from].y,
            newSectors[from].z
          );
          const b = new THREE.Vector3(
            newSectors[to].x,
            newSectors[to].y,
            newSectors[to].z
          );

          if (isTwoWay) {
            const key = `${Math.min(from, to)}-${Math.max(from, to)}`;
            if (!seenUndirected.has(key)) {
              seenUndirected.add(key);
              const line = new AnimatedLine(a, b, {
                material: lineMaterialTwoWay,
                directed: false,
              });
              rotationGroupRef.current.add(line.line);
              newAnimatedLines.push(line);
              (newWarpLineMap[from] ||= []).push(line);
              (newWarpLineMap[to] ||= []).push(line);
            }
          } else {
            const line = new AnimatedLine(a, b, {
              material: lineMaterialOneWay,
              directed: true,
            });
            rotationGroupRef.current.add(line.line);
            newAnimatedLines.push(line);
            (newWarpLineMap[from] ||= []).push(line);
            (newWarpLineMap[to] ||= []).push(line);
          }
        }
      }

      // Create meshes and labels
      for (const id of Object.keys(newSectors)) {
        const s = newSectors[id];
        let geo = geoSector,
          mat = matSector;
        if (s.type === "terra") {
          geo = geoTerra;
          mat = matTerra;
        } else if (s.type === "port") {
          geo = geoPort;
          mat = matPort;
        }

        const mesh = new THREE.Mesh(geo, mat.clone());
        mesh.position.set(s.x, s.y, s.z);
        mesh.userData = {
          sectorId: s.id,
          sector: s,
          originalEmissive: mesh.material.emissive.getHex(),
        };
        rotationGroupRef.current.add(mesh);
        newSectorMeshes[id] = mesh;

        const label = makeLabel(s.name, "#88ff88");
        if (label) {
          label.position.copy(mesh.position);
          label.position.y += 2;
          label.visible = false; // Start with labels hidden
          rotationGroupRef.current.add(label);
          newSectorLabels[id] = label;
        }
      }

      setSectors(newSectors);
      setSectorMeshes(newSectorMeshes);
      setSectorLabels(newSectorLabels);
      setAnimatedLines(newAnimatedLines);
      setWarpLineMap(newWarpLineMap);
    },
    [sectorMeshes, sectorLabels, animatedLines]
  );

  // Update label visibility based on camera distance and selection
  const updateLabelVisibility = useCallback(() => {
    if (!cameraRef.current) return;

    const cameraPosition = cameraRef.current.position;
    const labelDistanceThreshold = 50; // Distance threshold for showing labels
    const connectedSectors = new Set<number>();

    // Add selected and connected sectors
    if (selectedSector) {
      connectedSectors.add(selectedSector.id);
      selectedSector.warps_out.forEach((id) => connectedSectors.add(id));
      selectedSector.warps_in.forEach((id) => connectedSectors.add(id));
    }
    if (originSector) {
      connectedSectors.add(originSector.id);
      originSector.warps_out.forEach((id) => connectedSectors.add(id));
      originSector.warps_in.forEach((id) => connectedSectors.add(id));
    }

    Object.entries(sectorLabels).forEach(([id, label]) => {
      const sectorId = parseInt(id);
      const sector = sectors[sectorId];
      if (!sector) return;

      const distance = cameraPosition.distanceTo(
        new THREE.Vector3(sector.x, sector.y, sector.z)
      );
      const isConnected = connectedSectors.has(sectorId);
      const isClose = distance < labelDistanceThreshold;

      // Show label if sector is close to camera OR if it's connected/selected
      label.visible = isClose || isConnected;
    });
  }, [sectorLabels, sectors, selectedSector, originSector]);

  // Update line visibility based on selection
  const updateLineVisibility = useCallback(() => {
    const hasSelection = selectedSector || originSector;

    animatedLines.forEach((line) => {
      line.setVisible(hasSelection);
    });

    // Highlight lines for selected sector
    if (selectedSector) {
      (warpLineMap[selectedSector.id] || []).forEach((line) => {
        line.setVisible(true);
        line.setHighlighted(true);
      });
    }
  }, [animatedLines, warpLineMap, selectedSector, originSector]);

  // Mouse event handlers
  const handleMouseDown = () => setMouseDown(true);
  const handleMouseUp = () => setMouseDown(false);
  const handleMouseMove = (e: React.MouseEvent) => {
    if (mouseDown) {
      setTRotY((prev) => prev + (e.clientX - mouseX) * 0.02);
      setTRotX((prev) => prev + (e.clientY - mouseY) * 0.02);
    }
    setMouseX(e.clientX);
    setMouseY(e.clientY);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (cameraRef.current) {
      cameraRef.current.position.z += e.deltaY * 0.05;
      cameraRef.current.position.z = Math.max(
        20,
        Math.min(500, cameraRef.current.position.z)
      );
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (!cameraRef.current || !rendererRef.current) return;

    const rect = rendererRef.current.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, cameraRef.current);
    const intersects = raycaster.intersectObjects(Object.values(sectorMeshes));

    if (intersects.length > 0) {
      const sector = intersects[0].object.userData.sector;
      onSectorSelect?.(sector);
    }
  };

  // Effects
  useEffect(() => {
    const cleanup = initScene();
    return cleanup;
  }, [initScene]);

  useEffect(() => {
    if (layoutData && sectorData) {
      buildFromJson(layoutData, sectorData);
    }
  }, [layoutData, sectorData, buildFromJson]);

  useEffect(() => {
    updateLabelVisibility();
  }, [updateLabelVisibility]);

  useEffect(() => {
    updateLineVisibility();
  }, [updateLineVisibility]);

  // Update label visibility on camera movement
  useEffect(() => {
    const interval = setInterval(updateLabelVisibility, 100);
    return () => clearInterval(interval);
  }, [updateLabelVisibility]);

  return (
    <div
      ref={mountRef}
      style={{ width: "100%", height: "100%", position: "relative" }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
      onClick={handleClick}
    />
  );
};

export default StarMap;

