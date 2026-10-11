import { LABEL } from "./label.js";

export type RunFn = (label: string) => string;

export interface Reader {
  read(name: string): string;
}

export class FileStorage implements Reader {
  constructor(private readonly where: string) {}

  read(name: string): string {
    const path = this.where + name;
    return path + LABEL;
  }
}

export function compose(name: string): string {
  const joined = name + LABEL;
  function inner(): string {
    return joined;
  }
  return inner();
}
