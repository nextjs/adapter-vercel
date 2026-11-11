// Loading this optional host module is JavaScript-specific. Validation,
// destination selection, configuration and filesystem generation remain in Go.
export async function prepareGoFunctions(
  outputs: Array<{ id: string; filePath: string }>
) {
  if (!outputs.length) return undefined;
  const modulePath = process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH;
  if (!modulePath || !require('node:path').isAbsolute(modulePath)) {
    throw new Error(
      'Go outputs require a hosted @vercel/next Go packager (NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH)'
    );
  }
  const packager = require(modulePath);
  if (
    !packager ||
    packager.version !== 1 ||
    typeof packager.prepareGoFunction !== 'function'
  ) {
    throw new Error(
      'Unsupported @vercel/next Go packager: expected protocol version 1'
    );
  }
  const prepared: Record<string, unknown> = Object.create(null);
  for (const output of outputs) {
    prepared[output.id] = await packager.prepareGoFunction({
      userServerPath: output.filePath,
    });
  }
  return prepared;
}
