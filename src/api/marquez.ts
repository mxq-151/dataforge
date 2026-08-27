import { fetch } from '../bridge/http';
import type {
  MarquezApi,
  Lineage,
  NamespaceList,
  DatasetList,
  DatasetData,
  SearchResponse,
  LineageEventsResponse,
} from '../types/marquez';

export function createMarquezApi(apiUrl: string, extraHeaders?: Record<string, string>): MarquezApi {
  const baseUrl = apiUrl.replace(/\/+$/, '');

  const marquezRequest = async <T>(
    path: string,
    options: {
      method?: string;
      params?: Record<string, unknown>;
    } = {},
  ): Promise<T> => {
    const { method = 'GET', params } = options;
    let fullUrl = `${baseUrl}${path}`;

    if (params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      if (qs) fullUrl += `?${qs}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(fullUrl, {
        method,
        headers: { Accept: 'application/json', ...extraHeaders },
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unable to read error response');
        throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText.substring(0, 200)}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    lineage: {
      get(nodeId, depth = 20) {
        return marquezRequest<Lineage>('/api/v1/lineage', {
          params: { nodeId, depth },
        });
      },
      getColumnLineage(nodeId, depth = 20, withDownstream = false) {
        return marquezRequest<Lineage>('/api/v1/column-lineage', {
          params: { nodeId, depth, withDownstream },
        });
      },
    },
    namespaces: {
      list(limit = 100, offset = 0) {
        return marquezRequest<NamespaceList>('/api/v1/namespaces', {
          params: { limit, offset },
        });
      },
    },
    datasets: {
      list(namespace: string, limit = 100, offset = 0) {
        return marquezRequest<DatasetList>(`/api/v1/namespaces/${namespace}/datasets`, {
          params: { limit, offset },
        });
      },
      get(namespace: string, dataset: string) {
        return marquezRequest<DatasetData>(`/api/v1/namespaces/${namespace}/datasets/${dataset}`);
      },
    },
    search: {
      query(q, filter, sort, limit = 100, namespace) {
        const params: Record<string, unknown> = { q, limit };
        if (filter) params.filter = filter;
        if (sort) params.sort = sort;
        if (namespace) params.namespace = namespace;
        return marquezRequest<SearchResponse>('/api/v1/search', { params });
      },
    },
    events: {
      list(limit = 100, offset = 0) {
        return marquezRequest<LineageEventsResponse>('/api/v1/events/lineage', {
          params: { limit, offset },
        });
      },
    },
  };
}

export async function testMarquezConnection(apiUrl: string): Promise<{ success: boolean; message: string }> {
  try {
    const baseUrl = apiUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${baseUrl}/api/v1/namespaces?limit=1`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
      }
      const data = await res.json();
      if (data.namespaces !== undefined) {
        return { success: true, message: '连接成功' };
      }
      return { success: false, message: '响应格式不符合 Marquez API 规范' };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, message: '连接超时，请检查服务地址是否正确' };
    }
    return { success: false, message: e.message || '连接失败' };
  }
}
