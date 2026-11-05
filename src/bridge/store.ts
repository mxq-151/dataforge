/**
 * 持久化 Store（对应主进程 userData/df-stores/<file>.json）。
 *
 * Store.load(file) 返回缓存单例；get/set/delete 操作内存数据，
 * set 时自动持久化。
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

  /**
   * 返回当前全部数据的浅拷贝快照。
   * 供需要一次性预热本地缓存的调用方（如 SyncedStore）使用；
   * 返回副本以免外部改动绕过持久化直接污染内部数据。
   */
  async snapshot(): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    return { ...this.data };
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    // fire-and-forget 持久化，失败静默
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
