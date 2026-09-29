import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** External Pi cannot read app.asar. Keep its extension and dependencies together. */
export async function stageRuntimeExtension(sourceDirectory: string, runtimeDirectory: string) {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  // Copy dependencies first; a missing build artifact must reject startup, not launch Pi without tools.
  for (const name of ['desktop-protocol.js', 'speech-policy.js'])
    await copyFile(join(sourceDirectory, name), join(runtimeDirectory, name));
  const extensionPath = join(runtimeDirectory, 'friday-extension.mjs');
  await copyFile(join(sourceDirectory, 'friday-extension.js'), extensionPath);
  return extensionPath;
}
