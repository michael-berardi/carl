// Optional gateway plugins, chosen by config.
import type { CarlConfig } from "./config.ts";
import type { GatewayPlugin } from "./gateway.ts";

export async function loadPlugins(cfg: CarlConfig): Promise<GatewayPlugin[]> {
  const plugins: GatewayPlugin[] = [];
  const { UpdatePlugin } = await import("./update.ts");
  plugins.push(new UpdatePlugin());
  if (cfg.ultraterm) {
    const { UltraTermCompat } = await import("./compat/ultraterm.ts");
    plugins.push(new UltraTermCompat(cfg.ultraterm));
  }
  return plugins;
}
