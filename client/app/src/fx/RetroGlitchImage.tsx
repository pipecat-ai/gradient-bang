import React, { useEffect, useRef, useState } from "react";

// Error boundary component for RetroGlitchImage
class RetroGlitchImageErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.warn(
      "RetroGlitchImage: Error boundary caught error",
      error,
      errorInfo
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            background: "#000",
            color: "#0f0",
            padding: "20px",
            fontFamily: "monospace",
            border: "1px solid #0f0",
          }}
        >
          <div>DISPLAY ERROR</div>
          <div>RETRO GLITCH IMAGE FAILED</div>
          <div>RETRYING...</div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface RetroGlitchImageProps {
  /**
   * Image source URL or imported image. If null/undefined, component will show only effects without an image.
   */
  src?: string | null;

  /**
   * Fixed width in pixels (ignored if fillContainer is true)
   */
  width?: number;

  /**
   * Fixed height in pixels (ignored if fillContainer is true)
   */
  height?: number;

  /**
   * If true, component will fill its container and respond to resize
   */
  fillContainer?: boolean;

  /**
   * Size of pixels for pixelation effect (1-10 recommended)
   * @default 3
   */
  pixelSize?: number;

  /**
   * Intensity of scanline effect (0-1)
   * @default 0.15
   */
  scanlineIntensity?: number;

  /**
   * Frequency and intensity of glitch effects (0-1)
   * @default 0.8
   */
  glitchIntensity?: number;

  /**
   * Number of frames for transmission to complete
   * Higher = slower transmission
   * @default 50
   */
  transmissionSpeed?: number;

  /**
   * Frequency of big glitch effects (0-1)
   * 0 = never, 1 = very frequent
   * @default 0.02
   */
  bigGlitchFrequency?: number;

  /**
   * Duration of big glitch effect in frames
   * @default 10
   */
  bigGlitchDuration?: number;

  /**
   * Size of CRT scanlines in pixels (spacing between lines)
   * @default 3
   */
  crtScanlineSize?: number;

  /**
   * Intensity of the green phosphor glow in the center (0-1)
   * @default 1
   */
  centerGlowIntensity?: number;

  /**
   * Intensity of screen edge distortion (0-1)
   * 0 = no distortion, 1 = maximum barrel distortion
   * @default 0
   */
  screenDistortion?: number;

  /**
   * Terminal color for all green effects (scanlines, glow, text, etc.)
   * Accepts hex color codes like "#f5ff30" or "#00ff00"
   * @default "#00ff00"
   */
  terminalColor?: string;

  /**
   * How the image should fit within the container
   * - "contain": Scale image to fit entirely within container (may have letterboxing)
   * - "cover": Scale image to fill container while maintaining aspect ratio (may crop)
   * @default "contain"
   */
  imageFit?: "contain" | "cover";
}

interface Dimensions {
  width: number;
  height: number;
}

// Utility function to convert hex color to rgba string
const hexToRgba = (hex: string, alpha: number = 1): string => {
  // Remove # if present
  hex = hex.replace("#", "");

  // Parse hex values
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const RetroGlitchImage: React.FC<RetroGlitchImageProps> = ({
  src,
  width,
  height,
  fillContainer = false,
  pixelSize = 2,
  scanlineIntensity = 0.25,
  glitchIntensity = 0.8,
  transmissionSpeed = 30,
  bigGlitchFrequency = 0.005,
  bigGlitchDuration = 20,
  crtScanlineSize = 4,
  centerGlowIntensity = 1.5,
  screenDistortion = 0,
  terminalColor = "#00ff00",
  imageFit = "contain",
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions>({
    width: width || 800,
    height: height || 600,
  });
  const [imageLoaded, setImageLoaded] = useState<boolean>(false);
  const imageRef = useRef<HTMLImageElement>(new Image());

  // Handle container resize
  useEffect(() => {
    if (!fillContainer) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, [fillContainer]);

  // Load image
  useEffect(() => {
    if (!src) {
      // If no src provided, mark as loaded to show effects only
      setImageLoaded(true);
      return;
    }

    imageRef.current.onload = () => {
      setImageLoaded(true);
    };
    imageRef.current.onerror = () => {
      // If image fails to load, still mark as loaded to show effects
      setImageLoaded(true);
    };
    imageRef.current.src = src;
  }, [src]);

  // Main animation effect
  useEffect(() => {
    if (!imageLoaded) return;

    const canvas = canvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!canvas || !overlayCanvas) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const overlayCtx = overlayCanvas.getContext("2d");
    if (!ctx || !overlayCtx) return;

    const { width, height } = dimensions;

    // Validate dimensions
    if (width <= 0 || height <= 0 || isNaN(width) || isNaN(height)) {
      console.warn("RetroGlitchImage: Invalid container dimensions", {
        width,
        height,
      });
      return;
    }

    // Set canvas sizes
    canvas.width = width;
    canvas.height = height;
    overlayCanvas.width = width;
    overlayCanvas.height = height;

    // Animation variables
    let transmissionProgress = 0;
    let frame = 0;
    let staticNoise: ImageData;

    // Create static noise with validation
    try {
      staticNoise = new ImageData(width, height);
    } catch (error) {
      console.warn(
        "RetroGlitchImage: Failed to create static noise ImageData",
        error
      );
      // Create a minimal valid ImageData as fallback
      staticNoise = new ImageData(1, 1);
    }

    let slowScanlineY = 0;
    let bigGlitchActive = false;
    let bigGlitchFramesRemaining = 0;

    // Create pixelated version of image with optional barrel distortion
    const createPixelatedImage = (progress: number) => {
      const tempCanvas = document.createElement("canvas");
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return;

      // Calculate visible height based on transmission progress
      const visibleHeight = Math.floor(height * progress);

      // Clear canvas with black background
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      // If no image source or image not loaded, just return (effects will still be applied)
      if (
        !src ||
        !imageRef.current.complete ||
        imageRef.current.naturalWidth === 0
      ) {
        return;
      }

      // Calculate scaling dimensions to maintain aspect ratio
      let scaledWidth, scaledHeight, drawWidth, offsetX, offsetY;

      if (fillContainer) {
        // Calculate aspect ratios
        const containerAspect = width / height;
        const imageAspect =
          imageRef.current.naturalWidth / imageRef.current.naturalHeight;

        if (imageFit === "cover") {
          // Cover mode: fill container, may crop image
          if (containerAspect > imageAspect) {
            // Container is wider than image - fit to width (crop height)
            scaledWidth = width;
            scaledHeight = width / imageAspect;
            offsetX = 0;
            offsetY = (height - scaledHeight) / 2;
          } else {
            // Container is taller than image - fit to height (crop width)
            scaledHeight = height;
            scaledWidth = height * imageAspect;
            offsetX = (width - scaledWidth) / 2;
            offsetY = 0;
          }
        } else {
          // Contain mode: fit entire image, may have letterboxing
          if (containerAspect > imageAspect) {
            // Container is wider than image - fit to height
            scaledHeight = height;
            scaledWidth = height * imageAspect;
            offsetX = (width - scaledWidth) / 2;
            offsetY = 0;
          } else {
            // Container is taller than image - fit to width
            scaledWidth = width;
            scaledHeight = width / imageAspect;
            offsetX = 0;
            offsetY = (height - scaledHeight) / 2;
          }
        }

        drawWidth = scaledWidth;
      } else {
        // Use original dimensions when not filling container
        scaledWidth = width;
        scaledHeight = height;
        drawWidth = width;
        offsetX = 0;
        offsetY = 0;
      }

      // Validate dimensions to prevent errors
      if (
        scaledWidth <= 0 ||
        scaledHeight <= 0 ||
        isNaN(scaledWidth) ||
        isNaN(scaledHeight)
      ) {
        console.warn("RetroGlitchImage: Invalid dimensions calculated", {
          scaledWidth,
          scaledHeight,
          width,
          height,
        });
        return;
      }

      // Scale down for pixelation
      const pixelatedWidth = Math.floor(scaledWidth / pixelSize);
      const pixelatedHeight = Math.floor(scaledHeight / pixelSize);

      // Validate pixelated dimensions
      if (
        pixelatedWidth <= 0 ||
        pixelatedHeight <= 0 ||
        isNaN(pixelatedWidth) ||
        isNaN(pixelatedHeight)
      ) {
        console.warn("RetroGlitchImage: Invalid pixelated dimensions", {
          pixelatedWidth,
          pixelatedHeight,
          scaledWidth,
          scaledHeight,
          pixelSize,
        });
        return;
      }

      tempCanvas.width = pixelatedWidth;
      tempCanvas.height = pixelatedHeight;

      // Draw scaled down image
      tempCtx.imageSmoothingEnabled = false;

      if (imageFit === "cover" && fillContainer) {
        // For cover mode, we need to crop the image to fit the container
        const imageAspect =
          imageRef.current.naturalWidth / imageRef.current.naturalHeight;
        const containerAspect = width / height;

        let sourceX = 0,
          sourceY = 0,
          sourceWidth = imageRef.current.naturalWidth,
          sourceHeight = imageRef.current.naturalHeight;

        if (containerAspect > imageAspect) {
          // Container is wider - crop image height
          sourceHeight = imageRef.current.naturalWidth / containerAspect;
          sourceY = (imageRef.current.naturalHeight - sourceHeight) / 2;
        } else {
          // Container is taller - crop image width
          sourceWidth = imageRef.current.naturalHeight * containerAspect;
          sourceX = (imageRef.current.naturalWidth - sourceWidth) / 2;
        }

        tempCtx.drawImage(
          imageRef.current,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          pixelatedWidth,
          pixelatedHeight
        );
      } else {
        // Normal drawing for contain mode or non-fillContainer
        tempCtx.drawImage(
          imageRef.current,
          0,
          0,
          pixelatedWidth,
          pixelatedHeight
        );
      }

      // Draw back to main canvas scaled up
      ctx.imageSmoothingEnabled = false;

      // Only draw the transmitted portion
      if (visibleHeight > 0) {
        // Calculate the visible portion of the scaled image
        let visibleScaledHeight;
        if (fillContainer) {
          // When filling container, calculate based on the scaled height
          const scaledProgress = visibleHeight / height;
          visibleScaledHeight = Math.floor(scaledHeight * scaledProgress);
        } else {
          // When not filling container, use the original visible height
          visibleScaledHeight = visibleHeight;
        }

        // Validate visible height
        if (visibleScaledHeight <= 0 || isNaN(visibleScaledHeight)) {
          console.warn("RetroGlitchImage: Invalid visible height", {
            visibleScaledHeight,
            visibleHeight,
            scaledHeight,
          });
          return;
        }

        if (screenDistortion > 0) {
          // Apply barrel distortion effect
          try {
            const imageData = tempCtx.getImageData(
              0,
              0,
              pixelatedWidth,
              pixelatedHeight
            );
            const distortedCanvas = document.createElement("canvas");
            const distortedCtx = distortedCanvas.getContext("2d");
            if (!distortedCtx) return;

            distortedCanvas.width = pixelatedWidth;
            distortedCanvas.height = pixelatedHeight;
            const distortedImageData = distortedCtx.createImageData(
              pixelatedWidth,
              pixelatedHeight
            );

            const centerX = pixelatedWidth / 2;
            const centerY = pixelatedHeight / 2;
            const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY);

            for (let y = 0; y < pixelatedHeight; y++) {
              for (let x = 0; x < pixelatedWidth; x++) {
                const dx = x - centerX;
                const dy = y - centerY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // Barrel distortion formula - for CRT bulge effect
                const normalizedDist = distance / maxRadius;
                const distortionFactor =
                  1 + screenDistortion * 0.3 * normalizedDist * normalizedDist;

                const sourceX = Math.floor(centerX + dx / distortionFactor);
                const sourceY = Math.floor(centerY + dy / distortionFactor);

                if (
                  sourceX >= 0 &&
                  sourceX < pixelatedWidth &&
                  sourceY >= 0 &&
                  sourceY < pixelatedHeight
                ) {
                  const targetIndex = (y * pixelatedWidth + x) * 4;
                  const sourceIndex = (sourceY * pixelatedWidth + sourceX) * 4;

                  distortedImageData.data[targetIndex] =
                    imageData.data[sourceIndex];
                  distortedImageData.data[targetIndex + 1] =
                    imageData.data[sourceIndex + 1];
                  distortedImageData.data[targetIndex + 2] =
                    imageData.data[sourceIndex + 2];
                  distortedImageData.data[targetIndex + 3] =
                    imageData.data[sourceIndex + 3];
                }
              }
            }

            distortedCtx.putImageData(distortedImageData, 0, 0);
            ctx.drawImage(
              distortedCanvas,
              0,
              0,
              pixelatedWidth,
              Math.floor(visibleScaledHeight / pixelSize),
              offsetX,
              offsetY,
              drawWidth,
              visibleScaledHeight
            );
          } catch (error) {
            console.warn(
              "RetroGlitchImage: Error applying distortion effect",
              error
            );
            // Fallback to normal drawing without distortion
            ctx.drawImage(
              tempCanvas,
              0,
              0,
              pixelatedWidth,
              Math.floor(visibleScaledHeight / pixelSize),
              offsetX,
              offsetY,
              drawWidth,
              visibleScaledHeight
            );
          }
        } else {
          // No distortion - draw normally
          ctx.drawImage(
            tempCanvas,
            0,
            0,
            pixelatedWidth,
            Math.floor(visibleScaledHeight / pixelSize),
            offsetX,
            offsetY,
            drawWidth,
            visibleScaledHeight
          );
        }
      }
    };

    // Generate static noise
    const generateStatic = () => {
      try {
        for (let i = 0; i < staticNoise.data.length; i += 4) {
          const noise = Math.random() * 255;
          staticNoise.data[i] = noise; // R
          staticNoise.data[i + 1] = noise; // G
          staticNoise.data[i + 2] = noise; // B
          staticNoise.data[i + 3] = 30; // A
        }
      } catch (error) {
        console.warn("RetroGlitchImage: Error generating static noise", error);
      }
    };

    // Apply glitch effects
    const applyGlitchEffects = () => {
      try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        // Big glitch effect
        if (!bigGlitchActive && Math.random() < bigGlitchFrequency) {
          bigGlitchActive = true;
          bigGlitchFramesRemaining =
            Math.floor((Math.random() * bigGlitchDuration) / 2) +
            bigGlitchDuration / 2; // Random between half duration and full duration
        }

        if (bigGlitchActive) {
          bigGlitchFramesRemaining--;
          if (bigGlitchFramesRemaining <= 0) {
            bigGlitchActive = false;
          }

          // Create dramatic slicing effect
          const numSlices = Math.floor(Math.random() * 5) + 3;
          for (let i = 0; i < numSlices; i++) {
            const sliceY = Math.floor(Math.random() * height);
            const sliceHeight = Math.floor((Math.random() * height) / 4) + 10;
            const shift = Math.floor((Math.random() * width) / 2) - width / 4;
            const colorShift = Math.random() > 0.5;

            for (
              let y = sliceY;
              y < Math.min(sliceY + sliceHeight, height);
              y++
            ) {
              for (let x = 0; x < width; x++) {
                const sourceX = (x + shift + width) % width;
                const targetIndex = (y * width + x) * 4;
                const sourceIndex = (y * width + sourceX) * 4;

                if (colorShift) {
                  // Shift color channels separately for RGB split effect
                  data[targetIndex] =
                    data[sourceIndex + (Math.random() > 0.5 ? 1 : 0)];
                  data[targetIndex + 1] = data[sourceIndex + 1];
                  data[targetIndex + 2] =
                    data[sourceIndex + 2 + (Math.random() > 0.5 ? -1 : 0)];
                } else {
                  data[targetIndex] = data[sourceIndex];
                  data[targetIndex + 1] = data[sourceIndex + 1];
                  data[targetIndex + 2] = data[sourceIndex + 2];
                }
              }
            }
          }

          // Add some static noise during big glitch
          for (let i = 0; i < data.length; i += 4) {
            if (Math.random() < 0.1) {
              const noise = Math.random() * 255;
              data[i] = noise;
              data[i + 1] = noise;
              data[i + 2] = noise;
            }
          }
        }

        // Random horizontal shifts (glitch lines)
        if (Math.random() < glitchIntensity * 0.3 && frame % 3 === 0) {
          const glitchY = Math.floor(Math.random() * height);
          const glitchHeight = Math.floor(Math.random() * 20) + 5;
          const shift = Math.floor(Math.random() * 20) - 10;

          for (
            let y = glitchY;
            y < Math.min(glitchY + glitchHeight, height);
            y++
          ) {
            for (let x = 0; x < width; x++) {
              const sourceX = (x + shift + width) % width;
              const targetIndex = (y * width + x) * 4;
              const sourceIndex = (y * width + sourceX) * 4;

              data[targetIndex] = data[sourceIndex];
              data[targetIndex + 1] = data[sourceIndex + 1];
              data[targetIndex + 2] = data[sourceIndex + 2];
            }
          }
        }

        // Color channel separation
        if (Math.random() < glitchIntensity * 0.2) {
          const separation = Math.floor(Math.random() * 4) + 1;
          for (let y = 0; y < height; y++) {
            for (let x = separation; x < width; x++) {
              const index = (y * width + x) * 4;
              const sourceIndex = (y * width + (x - separation)) * 4;
              data[index] = data[sourceIndex]; // Shift red channel
            }
          }
        }

        // Random pixel corruption
        if (Math.random() < glitchIntensity * 0.4) {
          const corruptionCount = Math.floor(100 * glitchIntensity);
          for (let i = 0; i < corruptionCount; i++) {
            const x = Math.floor(Math.random() * width);
            const y = Math.floor(Math.random() * height);
            const index = (y * width + x) * 4;

            data[index] = Math.random() * 255;
            data[index + 1] = Math.random() * 255;
            data[index + 2] = Math.random() * 255;
          }
        }

        ctx.putImageData(imageData, 0, 0);
      } catch (error) {
        console.warn("RetroGlitchImage: Error applying glitch effects", error);
      }
    };

    // Add scanlines
    const addScanlines = () => {
      // Static scanlines - more visible with higher intensity
      ctx.fillStyle = `rgba(0, 0, 0, ${scanlineIntensity * 0.5})`;
      for (let y = 0; y < height; y += 2) {
        ctx.fillRect(0, y, width, 1);
      }

      // Additional dimming between scanlines for higher intensity
      if (scanlineIntensity > 0.3) {
        ctx.fillStyle = `rgba(0, 0, 0, ${(scanlineIntensity - 0.3) * 0.3})`;
        for (let y = 1; y < height; y += 2) {
          ctx.fillRect(0, y, width, 1);
        }
      }

      // Moving scanline - intensity affects visibility
      const scanlineY = (frame * 2) % height;
      ctx.fillStyle = hexToRgba(terminalColor, 0.05 + scanlineIntensity * 0.1);
      ctx.fillRect(0, scanlineY, width, 2);

      // Slower, bigger scanline - more prominent with higher intensity
      slowScanlineY = (slowScanlineY + 0.5) % (height + 100);
      const gradient = ctx.createLinearGradient(
        0,
        slowScanlineY - 50,
        0,
        slowScanlineY + 50
      );
      gradient.addColorStop(0, hexToRgba(terminalColor, 0));
      gradient.addColorStop(
        0.5,
        hexToRgba(terminalColor, 0.1 + scanlineIntensity * 0.2)
      );
      gradient.addColorStop(1, hexToRgba(terminalColor, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, slowScanlineY - 50, width, 100);
    };

    // Add CRT overlay effects (on overlay canvas)
    const addCRTOverlay = () => {
      // Clear overlay canvas
      overlayCtx.clearRect(0, 0, width, height);

      // CRT scanlines with flicker
      const flickerIntensity = 0.02 + Math.random() * 0.03;
      overlayCtx.fillStyle = `rgba(0, 0, 0, ${scanlineIntensity * 0.4})`;
      for (let y = 0; y < height; y += crtScanlineSize) {
        overlayCtx.fillRect(0, y, width, 1);
      }

      // Subtle phosphor glow lines (only if scanlines are large enough)
      if (crtScanlineSize >= 3) {
        overlayCtx.fillStyle = hexToRgba(terminalColor, flickerIntensity);
        for (let y = 1; y < height; y += crtScanlineSize) {
          overlayCtx.fillRect(0, y, width, 1);
        }
      }

      // Center phosphor glow - terminal color glow from center
      const centerGlow = overlayCtx.createRadialGradient(
        width / 2,
        height / 2,
        0,
        width / 2,
        height / 2,
        Math.min(width, height) * centerGlowIntensity
      );
      centerGlow.addColorStop(
        0,
        hexToRgba(terminalColor, 0.08 + flickerIntensity * 0.5)
      );
      centerGlow.addColorStop(
        0.3,
        hexToRgba(terminalColor, 0.04 + flickerIntensity * 0.3)
      );
      centerGlow.addColorStop(0.6, hexToRgba(terminalColor, 0.02));
      centerGlow.addColorStop(1, hexToRgba(terminalColor, 0));
      overlayCtx.fillStyle = centerGlow;
      overlayCtx.fillRect(0, 0, width, height);

      // Vignette effect - stronger in corners
      const vignette = overlayCtx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.3,
        width / 2,
        height / 2,
        Math.sqrt(width * width + height * height) / 2
      );
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(0.5, "rgba(0, 0, 0, 0.2)");
      vignette.addColorStop(0.8, "rgba(0, 0, 0, 0.5)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.8)");
      overlayCtx.fillStyle = vignette;
      overlayCtx.fillRect(0, 0, width, height);

      // Screen edge distortion
      overlayCtx.strokeStyle = "rgba(0, 0, 0, 0.3)";
      overlayCtx.lineWidth = 20;
      overlayCtx.beginPath();
      overlayCtx.moveTo(0, 0);
      overlayCtx.quadraticCurveTo(width / 2, 15, width, 0);
      overlayCtx.moveTo(0, height);
      overlayCtx.quadraticCurveTo(width / 2, height - 15, width, height);
      overlayCtx.stroke();

      // Subtle overall flicker
      if (Math.random() < 0.1) {
        overlayCtx.fillStyle = `rgba(0, 0, 0, ${Math.random() * 0.05})`;
        overlayCtx.fillRect(0, 0, width, height);
      }
    };

    // Add interference
    const addInterference = () => {
      try {
        if (transmissionProgress < 0.98 && Math.random() < 0.1) {
          generateStatic();
          ctx.putImageData(staticNoise, 0, 0);

          // Add terminal color tint to static
          ctx.fillStyle = hexToRgba(terminalColor, 0.1);
          ctx.fillRect(0, 0, width, height);
        }
      } catch (error) {
        console.warn("RetroGlitchImage: Error adding interference", error);
      }
    };

    // Animation loop
    const animate = () => {
      try {
        // Update transmission progress
        if (transmissionProgress < 1) {
          transmissionProgress += 1 / transmissionSpeed;
          transmissionProgress = Math.min(transmissionProgress, 1);
        }

        // Clear canvas
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);

        // Draw pixelated image with transmission effect
        createPixelatedImage(transmissionProgress);

        // Apply effects
        if (transmissionProgress > 0.1) {
          applyGlitchEffects();
        }

        addInterference();

        // Save the current state before applying overlay effects
        ctx.save();

        // Apply scanlines with different blend mode based on intensity
        if (scanlineIntensity > 0.5) {
          // For high intensity, use normal blending for stronger effect
          ctx.globalCompositeOperation = "source-over";
        } else {
          // For low intensity, use screen for subtler effect
          ctx.globalCompositeOperation = "screen";
        }
        addScanlines();
        ctx.restore();

        // Apply CRT overlay effects on the separate canvas
        addCRTOverlay();

        // Add text overlay during transmission
        if (transmissionProgress < 1) {
          ctx.fillStyle = hexToRgba(terminalColor, 0.8);
          ctx.font = "14px TX-02";

          const message = src
            ? `RECEIVING TRANSMISSION... ${Math.floor(
                transmissionProgress * 100
              )}%`
            : `INITIALIZING DISPLAY... ${Math.floor(
                transmissionProgress * 100
              )}%`;

          ctx.fillText(message, 20, 30);

          // Blinking cursor
          if (frame % 30 < 15) {
            ctx.fillRect(20 + ctx.measureText(message).width + 5, 15, 10, 20);
          }
        }

        frame++;
        animationRef.current = requestAnimationFrame(animate);
      } catch (error) {
        console.warn("RetroGlitchImage: Error in animation loop", error);
        // Try to continue animation if possible
        frame++;
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    animate();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [
    imageLoaded,
    dimensions,
    pixelSize,
    scanlineIntensity,
    glitchIntensity,
    transmissionSpeed,
    bigGlitchFrequency,
    bigGlitchDuration,
    crtScanlineSize,
    centerGlowIntensity,
    screenDistortion,
    terminalColor,
    fillContainer,
    imageFit,
    src, // Add src to dependencies
  ]);

  const containerStyle = fillContainer
    ? { width: "100%", height: "100%" }
    : { width: dimensions.width, height: dimensions.height };

  return (
    <RetroGlitchImageErrorBoundary>
      <div
        ref={containerRef}
        style={{ ...containerStyle, background: "#000", position: "relative" }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            imageRendering: "pixelated",
            filter: "contrast(1.2) brightness(1.1)",
            position: "absolute",
            top: 0,
            left: 0,
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          style={{
            display: "block",
            position: "absolute",
            top: 0,
            left: 0,
            pointerEvents: "none",
            mixBlendMode: "normal",
          }}
        />
      </div>
    </RetroGlitchImageErrorBoundary>
  );
};
