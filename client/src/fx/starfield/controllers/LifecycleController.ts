type LifecycleCallbacks = {
  onVisibilityHidden: () => void;
  onVisibilityVisible: () => void;
  onWindowBlur: () => void;
  onWindowFocus: () => void;
  onResize: () => void;
};

/**
 * Coordinates document/window lifecycle listeners for the starfield.
 * Keeps listener setup/teardown in one place so GalaxyStarfield stays focused on rendering.
 */
export class LifecycleController {
  private readonly callbacks: LifecycleCallbacks;
  private resizeObserver?: ResizeObserver;
  private resizeTimeoutId: number | null = null;
  private isAttached = false;

  private readonly handleVisibilityChange = () => {
    if (document.hidden) {
      this.callbacks.onVisibilityHidden();
    } else {
      this.callbacks.onVisibilityVisible();
    }
  };

  private readonly handleWindowBlur = () => {
    this.callbacks.onWindowBlur();
  };

  private readonly handleWindowFocus = () => {
    this.callbacks.onWindowFocus();
  };

  private readonly handleWindowResize = () => {
    if (this.resizeTimeoutId !== null) {
      clearTimeout(this.resizeTimeoutId);
    }
    this.resizeTimeoutId = window.setTimeout(() => {
      requestAnimationFrame(() => {
        this.callbacks.onResize();
      });
    }, 100);
  };

  constructor(callbacks: LifecycleCallbacks) {
    this.callbacks = callbacks;
  }

  public attach(targetElement?: HTMLElement | null): void {
    if (this.isAttached) return;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("blur", this.handleWindowBlur);
    window.addEventListener("focus", this.handleWindowFocus);

    if (window.ResizeObserver && targetElement) {
      try {
        this.resizeObserver = new ResizeObserver((entries) => {
          if (entries.length === 0) return;
          requestAnimationFrame(() => {
            this.callbacks.onResize();
          });
        });
        this.resizeObserver.observe(targetElement);
      } catch {
        window.addEventListener("resize", this.handleWindowResize);
      }
    } else {
      window.addEventListener("resize", this.handleWindowResize);
    }

    this.isAttached = true;
  }

  public detach(): void {
    if (!this.isAttached) return;
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
    window.removeEventListener("blur", this.handleWindowBlur);
    window.removeEventListener("focus", this.handleWindowFocus);
    window.removeEventListener("resize", this.handleWindowResize);

    if (this.resizeObserver) {
      try {
        this.resizeObserver.disconnect();
      } catch {
        // ignore errors during disconnect
      }
      this.resizeObserver = undefined;
    }

    if (this.resizeTimeoutId !== null) {
      clearTimeout(this.resizeTimeoutId);
      this.resizeTimeoutId = null;
    }

    this.isAttached = false;
  }
}
