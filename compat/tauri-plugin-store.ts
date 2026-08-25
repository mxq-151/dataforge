/**
 * @tauri-apps/plugin-store 兼容垫片。
 *
 * 语义与 Tauri 版一致：Store.load(file) 返回缓存单例；get/set/delete 操作
 * 内存数据，set 时自动持久化（写入主进程 userData/df-stores/<file>.json）。
 */
type StoreData = Record<string, unknown>;

export class Store {
  private static cache = new Map<string, Store>();
  private data: StoreData = {};
  private loaded = false;
  private readonly key: string;

  private constructor(key: string) {
    this.key = key;
  }

  static async load(key: string): Promise<Store> {
    let store = Store.cache.get(key);
    if (!store) {
      store = new Store(key);
      Store.cache.set(key, store);
    }
    await store.ensureLoaded();
    return store;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await window.dataforge.storeRead(this.key);
      this.data = data && typeof data === 'object' ? (data as StoreData) : {};
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.data[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    // Tauri 版在 set 后会异步持久化；这里 fire-and-forget，失败静默
    window.dataforge.storeWrite(this.key, this.data).catch(() => {});
  }

  async delete(key: string): Promise<boolean> {
    const had = key in this.data;
    if (had) {
      delete this.data[key];
      window.dataforge.storeWrite(this.key, this.data).catch(() => {});
    }
    return had;
  }

  async save(): Promise<void> {
    await window.dataforge.storeWrite(this.key, this.data).catch(() => {});
  }
}