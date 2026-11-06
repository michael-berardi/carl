// Adapter registry: a platform is one file in adapters/ and one line here.
import type { PostAdapter } from "./types.ts";
import { PostError } from "./types.ts";
import { xAdapter } from "./adapters/x.ts";

export class AdapterRegistry {
  private readonly adapters = new Map<string, PostAdapter>();
  register(adapter: PostAdapter): this {
    this.adapters.set(adapter.platform, adapter);
    return this;
  }
  get(platform: string): PostAdapter {
    const a = this.adapters.get(platform);
    if (!a) throw new PostError(`no adapter for platform "${platform}" (available: ${this.platforms().join(", ") || "none"})`, true);
    return a;
  }
  platforms(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(xAdapter);
}
