import { Html, useProgress } from "@react-three/drei";
import { useEffect, useState } from "react";

/**
 * Simple loading component that displays inside the Canvas
 * Used as a Suspense fallback for individual components
 */
export function CanvasLoader() {
  return (
    <Html center>
      <div
        style={{
          color: "#ffffff",
          fontSize: "14px",
          fontFamily: "monospace",
          textAlign: "center",
        }}
      >
        Loading...
      </div>
    </Html>
  );
}

/**
 * Full-screen loading overlay with progress tracking
 * Uses Drei's useProgress hook to track asset loading
 *
 * This component is rendered outside the Canvas and provides
 * a professional loading experience with progress feedback
 */
export function LoadingScreen() {
  const { active, progress, errors, item, loaded, total } = useProgress();
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (!active && progress === 100) {
      // Add a small delay before hiding to ensure smooth transition
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(true);
    }
  }, [active, progress]);

  if (!isVisible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#000000",
        zIndex: 1000,
        transition: "opacity 0.5s ease-out",
        opacity: isVisible ? 1 : 0,
        pointerEvents: isVisible ? "auto" : "none",
      }}
    >
      {/* Loading text */}
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "24px",
          color: "#ffffff",
          marginBottom: "20px",
          letterSpacing: "2px",
        }}
      >
        INITIALIZING
      </div>

      {/* Progress bar container */}
      <div
        style={{
          width: "300px",
          height: "4px",
          backgroundColor: "rgba(255, 255, 255, 0.1)",
          borderRadius: "2px",
          overflow: "hidden",
          marginBottom: "20px",
        }}
      >
        {/* Progress bar fill */}
        <div
          style={{
            height: "100%",
            backgroundColor: "#ffffff",
            width: `${progress}%`,
            transition: "width 0.3s ease-out",
            borderRadius: "2px",
          }}
        />
      </div>

      {/* Progress percentage */}
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "14px",
          color: "rgba(255, 255, 255, 0.6)",
          marginBottom: "10px",
        }}
      >
        {Math.round(progress)}%
      </div>

      {/* Loading details */}
      {item && (
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "12px",
            color: "rgba(255, 255, 255, 0.4)",
            maxWidth: "300px",
            textAlign: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {loaded}/{total} • {item}
        </div>
      )}

      {/* Error display */}
      {errors.length > 0 && (
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#ff6b6b",
            marginTop: "20px",
            maxWidth: "300px",
            textAlign: "center",
          }}
        >
          Warning: {errors.length} error(s) occurred
        </div>
      )}

      {/* Animated dots */}
      <div
        style={{
          marginTop: "20px",
          display: "flex",
          gap: "8px",
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: "rgba(255, 255, 255, 0.3)",
              animation: `pulse 1.5s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>

      {/* Add keyframe animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 0.3;
            transform: scale(0.8);
          }
          50% {
            opacity: 1;
            transform: scale(1.2);
          }
        }
      `}</style>
    </div>
  );
}

/**
 * Minimal loading component for quick async operations
 * Used when you just need a simple "Loading..." indicator
 */
export function MinimalLoader() {
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#ffffff",
        zIndex: 100,
      }}
    >
      Loading...
    </div>
  );
}
