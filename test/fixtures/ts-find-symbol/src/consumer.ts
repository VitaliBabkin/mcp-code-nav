import { Circle, scaled } from "./shapes.js";

export function describe(): string {
  const local = scaled.label;
  const circle = Circle.create();
  return `${local}${circle.radius}`;
}

export const promised: Promise<number> = Promise.resolve(1);
