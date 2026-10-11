// Live shape for `ts_find_symbol`: a variable with an inferred type, overloads, a merged class/interface
// pair and a type alias, plus `area` declared again in `lib/area.ts` so one name has a row in two
// directories.

export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  radius = 1;
  area(): number {
    return 3 * this.radius * this.radius;
  }
  static create(): Circle {
    return new Circle();
  }
}

export function area(shape: Shape): number {
  return shape.area();
}

export const DEFAULT_RADIUS = 10;

function computeScale(factor: number) {
  return { factor: factor * 2, label: "scaled" };
}

export const scaled = computeScale(DEFAULT_RADIUS);

export function parse(text: string): number;
export function parse(value: number): string;
export function parse(value: string | number): string | number {
  return typeof value === "string" ? Number(value) : String(value);
}

export class Merged {
  label = "m";
}
export interface Merged {
  extra: number;
}

export type ShapeName = "circle" | "square";

export namespace Geometry {
  export class Worker {
    run(): string {
      return "geometry";
    }
  }
  export const UNIT = 1;
}

export class Driver {
  run(): string {
    return "driver";
  }
}

export class Worker {
  run(): number {
    return 1;
  }
}
