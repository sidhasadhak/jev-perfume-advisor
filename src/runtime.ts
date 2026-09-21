/**
 * The oldest Node this app runs on: process.loadEnvFile (reads .env) arrived in 20.12
 * and AbortSignal.any in 20.3, so older versions would start and then fail cryptically.
 * Keep in sync with "engines" in package.json (a test checks this).
 */
export const MIN_NODE = [20, 12] as const;

export function nodeTooOld(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

export function nodeVersionMessage(version: string = process.versions.node): string {
  return `This app needs Node.js ${MIN_NODE.join('.')} or newer, but you are running ${version}. `
    + 'Install the current LTS from https://nodejs.org (or run "nvm install" in this folder), then try again.';
}
