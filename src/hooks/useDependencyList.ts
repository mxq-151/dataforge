import { useState, useCallback } from 'react';
import { fetchDependencyList } from '../api/dependency';
import type { DependencyRecord } from '../api/dependency';

export interface DependencyGroup {
  programType: string;
  items: DependencyRecord[];
}

const useDependencyList = () => {
  const [records, setRecords] = useState<DependencyRecord[]>([]);
  const [groups, setGroups] = useState<DependencyGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDependencies = useCallback(async (programType?: string) => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchDependencyList(
        programType ? { programType } : undefined
      );
      if (json.code !== 200) throw new Error(json.message || '请求失败');
      setRecords(json.data.records);
      const groupedMap = new Map<string, DependencyRecord[]>();
      json.data.records.forEach(item => {
        const pt = item.programType || '未分类';
        if (!groupedMap.has(pt)) groupedMap.set(pt, []);
        groupedMap.get(pt)!.push(item);
      });
      const sortedGroups = Array.from(groupedMap.entries()).map(([pt, items]) => ({
        programType: pt,
        items,
      }));
      setGroups(sortedGroups);
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取依赖列表失败');
      setRecords([]);
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return { records, groups, loading, error, fetchDependencies };
};

export default useDependencyList;
