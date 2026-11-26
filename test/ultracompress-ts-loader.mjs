// Test-only resolver: the vendored Pi adapter uses extensionless ESM imports, which
// Pi resolves itself. Node's built-in TypeScript stripper needs the .ts suffix.
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith(".") &&
    context.parentURL?.includes("/vendor/ultracompress/") &&
    !/\.(?:[cm]?[jt]sx?|json|node)$/.test(specifier)
  ) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the original specifier (e.g. a directory import).
    }
  }
  return nextResolve(specifier, context);
}
