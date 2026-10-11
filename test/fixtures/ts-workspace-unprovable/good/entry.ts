/*
  The half of `ts-workspace-unprovable` that WORKS: a project whose listing succeeds and whose own files it
  owns, reached through the root config's `references` like every other project here.

  The workspace's closure is unprovable (the root `tsconfig.json` extends `./gone.json`, which resolves to
  nothing), so every call answers from a freshly spawned process. That is the cost, and what must NOT come with it is this:
  the project map is still built from the paths
  the walk did see, so this project is still mapped, anchored and able to answer across its own two files.
  the missing half is this — with both of the workspace's other configs failing, no live case
  could show a healthy project anchored in an unprovable workspace at all.
*/

export function goodName(): string {
  return "good";
}
