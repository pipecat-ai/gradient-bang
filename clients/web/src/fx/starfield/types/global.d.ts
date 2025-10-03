declare global {
  interface RGBColor {
    r: number;
    g: number;
    b: number;
  }

  /** RGBA color interface with normalized values (0-1) */
  interface RGBAColor extends RGBColor {
    a: number;
  }

  /** 2D vector interface */
  interface Vector2 {
    x: number;
    y: number;
  }

  /** 3D vector interface */
  interface Vector3 {
    x: number;
    y: number;
    z: number;
  }

  /** 4D vector interface */
  interface Vector4 {
    x: number;
    y: number;
    z: number;
    w: number;
  }
}

export {};
