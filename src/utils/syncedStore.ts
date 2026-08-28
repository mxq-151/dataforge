import { Store } from '../bridge/store';

/**
 * 同步读写的持久化外观，基于 bridge/store（主进程 userData/df-stores/*.json）。
 *
 * 用途：替代 localStorage 存放**敏感或较大**的本地数据（如登录凭据、查询历史）。
 * localStorage 可被页面脚本直接读取，明文凭据落在这里存在 XSS 窃取风险——项目对
 * token 与 API Key 已采取「只写 Store」的立场（见 api/index.ts、useOpencodeConfig.ts），
 * 登录凭据却仍留在 localStorage，故引入本类统一收口。
 *
 * 机制：init() 时把该文件的全部数据预热进内存；此后 get/set/delete 均同步操作内存，
 * 写操作自动异步落盘（fire-and-forget）。这样既拿到磁盘持久化的安全性，又保持
 * localStorage 式的同步调用体验，调用方无需逐个改成 await。
 *
 * 注意：init() 完成前 get 一律返回 undefined，调用方应等 ready 后再读。
 */
export class SyncedStore {
  private store: Store | null = null;
  private cache: Record<string, unknown> = {};
  private ready = false;
  /** 缓存 init 的 Promise：并发调用时共享同一次加载，避免后调用者读到尚未填充的空缓存 */
  private initPromise: Promise<void> | null = null;

  constructor(private readonly file: string) {}

  /** 加载磁盘数据到内存。可重复调用，幂等。 */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      this.store = await Store.load(this.file);
      const disk = await this.store.snapshot();
      // init 是异步的，期间可能已经有同步写入（那时 store 尚未就绪，只落到了 cache）。
      // 若直接整体覆盖 cache，这些早期写入会被静默丢弃——合并时以内存写入为准，
      // 并把它们补写回磁盘，保证不丢。
      const pending = this.cache;
      this.cache = { ...disk, ...pending };
      for (const [k, v] of Object.entries(pending)) {
        void this.store.set(k, v);
      }
    } catch {
      // Store 不可用时降级为纯内存，不影响主流程（保留 init 期间已写入的 cache）
    }
    this.ready = true;
  }

  /** 数据是否已就绪（未就绪时读取会拿到空值） */
  get isReady(): boolean {
    return this.ready;
  }

  get<T>(key: string): T | undefined {
    return this.cache[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.cache[key] = value;
    void this.store?.set(key, value);
  }

  delete(key: string): void {
    delete this.cache[key];
    void this.store?.delete(key);
  }
}

/** 按文件缓存 SyncedStore 实例，避免同一文件重复加载 */
const registry = new Map<string, SyncedStore>();

export function getSyncedStore(file: string): SyncedStore {
  let s = registry.get(file);
  if (!s) {
    s = new SyncedStore(file);
    registry.set(file, s);
  }
  return s;
}
