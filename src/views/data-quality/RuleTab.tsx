/**
 * 规则配置页签（数据质量 → 规则配置）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 按表配置监控规则：左侧是「数据源 → 库 → 表」树，右侧是选中表的规则清单。
 * 规则类型固定为 types/quality 的 7 类，字段级规则必须选字段，跨表规则必须选对照表，
 * 由 QualityRuleTypeMeta.scope 决定表单形态（COLUMN / TABLE / PAIR）。
 *
 * ── 左树为什么不用 /api/asset/catalog/tree ──────────────────
 * 资产目录树（引擎视角 / 规范视角）服务端尚未接入。质量配置只需要「能选到表」，
 * 因此直接消费 DataSourceProvider 已缓存的元数据（数据源 + 库 + 表），不新增请求，
 * 也不依赖未就绪的目录树接口。
 *
 * ── 接口 ────────────────────────────────────────────────────
 * 走 api/quality 的 /quality/rule*（suppressError: true）。试跑不落运行实例，
 * 用于保存前验证阈值是否合理；批量配置按模板一次为多张表生成同类型规则。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Plus,
  RotateCcw,
  Edit3,
  Trash2,
  Play,
  Power,
  Layers3,
  Database,
  Table2,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  RefreshCw,
  CopyPlus,
  FileUp,
} from 'lucide-react';
import { qualityApi } from '../../api/quality';
import type { QualityRuleSaveDTO } from '../../api/quality';
import type {
  QualityRuleVO,
  QualityRuleResultVO,
  QualityRuleTemplateVO,
  QualityCompareMode,
  QualityDisposeMode,
} from '../../types/quality';
import { QUALITY_RULE_TYPES, QUALITY_DISPOSE_MODES, getQualityRuleType } from '../../types/quality';
import { parseQualityRulesFromDesignDoc, matchQualityTable } from '../../utils/qualityRuleImport';
import type { ParsedQualityRule } from '../../utils/qualityRuleImport';
import { fetchTableColumns } from '../../api/datasource';
import type { TableDetailColumn, TableInfo } from '../../api/datasource';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import { useToast } from '../../components/Toast';

/** 比较方式 —— 与规则阈值共同决定「实际值 vs 阈值」的判定 */
const COMPARE_MODES: Array<{ code: QualityCompareMode; label: string }> = [
  { code: 'EQ', label: '等于' },
  { code: 'NE', label: '不等于' },
  { code: 'GT', label: '大于' },
  { code: 'GTE', label: '大于等于' },
  { code: 'LT', label: '小于' },
  { code: 'LTE', label: '小于等于' },
];

const COMPARE_LABEL: Record<string, string> = Object.fromEntries(COMPARE_MODES.map(m => [m.code, m.label]));
const DISPOSE_LABEL: Record<string, string> = Object.fromEntries(QUALITY_DISPOSE_MODES.map(m => [m.code, m.label]));
const CHECK_STATUS_LABEL: Record<string, string> = {
  PASS: '通过',
  WARN: '橙色异常',
  ERROR: '红色异常',
  FAILED: '校验失败',
};

/** 元数据里库名可能缺失（未同步完整），而规则必须落到「库.表」，因此先窄化 */
type TreeTable = TableInfo & { databaseName: string };
const hasDatabase = (t: TableInfo): t is TreeTable => Boolean(t.databaseName);

/** 左树选中的表 */
interface SelectedTable {
  datasourceId: number;
  datasourceName: string;
  databaseName: string;
  tableName: string;
  storageEngine: string;
}

/**
 * 导入预览行：解析结果 + 元数据匹配结果 + 可落库判定。
 * 解析器只做「按契约取值」，能不能落库取决于平台侧能不能匹配到库表，因此判定放在界面层。
 */
interface ImportRow {
  rule: ParsedQualityRule;
  /** 匹配到的平台表；未匹配到时为空 */
  target?: { datasourceId: number; datasourceName: string; databaseName: string; tableName: string };
  /** 修正后的字段名（「库.表」被误读成「表.字段」时会清空，待人工补） */
  columnName: string;
  /** 不可落库的原因；为空表示可落库 */
  blocked: string;
}

interface RuleFormState {
  id?: number;
  ruleName: string;
  ruleType: string;
  columnName: string;
  partitionExpr: string;
  compareMode: QualityCompareMode;
  expectedValue: string;
  warnThreshold: string;
  errorThreshold: string;
  disposeMode: QualityDisposeMode;
  ownerName: string;
  enabled: boolean;
  refDatasourceId: number | null;
  refDatabaseName: string;
  refTableName: string;
  refColumnName: string;
}

const emptyForm = (): RuleFormState => ({
  ruleName: '',
  ruleType: QUALITY_RULE_TYPES[0].code,
  columnName: '',
  partitionExpr: '',
  compareMode: 'GTE',
  expectedValue: '',
  warnThreshold: '',
  errorThreshold: '',
  disposeMode: 'ALERT',
  ownerName: '',
  enabled: true,
  refDatasourceId: null,
  refDatabaseName: '',
  refTableName: '',
  refColumnName: '',
});

/** 规则 VO → 表单态 */
function toForm(row: QualityRuleVO): RuleFormState {
  return {
    id: row.id,
    ruleName: row.ruleName,
    ruleType: row.ruleType,
    columnName: row.columnName ?? '',
    partitionExpr: row.partitionExpr ?? '',
    compareMode: row.compareMode ?? 'GTE',
    expectedValue: row.expectedValue ?? '',
    warnThreshold: row.warnThreshold ?? '',
    errorThreshold: row.errorThreshold ?? '',
    disposeMode: row.disposeMode ?? 'ALERT',
    ownerName: row.ownerName ?? '',
    enabled: row.enabled ?? true,
    refDatasourceId: row.refDatasourceId,
    refDatabaseName: row.refDatabaseName ?? '',
    refTableName: row.refTableName ?? '',
    refColumnName: row.refColumnName ?? '',
  };
}

/** 规则 VO → 保存入参（剔除服务端生成字段），启停也走这条路径覆盖保存 */
function toPayload(row: QualityRuleVO): QualityRuleSaveDTO {
  return {
    id: row.id,
    ruleName: row.ruleName,
    ruleType: row.ruleType,
    templateId: row.templateId,
    templateCode: row.templateCode,
    datasourceId: row.datasourceId,
    datasourceName: row.datasourceName,
    databaseName: row.databaseName,
    tableName: row.tableName,
    columnName: row.columnName,
    partitionExpr: row.partitionExpr,
    refDatasourceId: row.refDatasourceId,
    refDatabaseName: row.refDatabaseName,
    refTableName: row.refTableName,
    refColumnName: row.refColumnName,
    compareMode: row.compareMode,
    expectedValue: row.expectedValue,
    warnThreshold: row.warnThreshold,
    errorThreshold: row.errorThreshold,
    disposeMode: row.disposeMode,
    ownerName: row.ownerName,
    enabled: row.enabled,
  };
}

/** 阈值展示：期望值 + 橙色/红色阈值，缺失显示占位符 */
function thresholdText(row: QualityRuleVO): string {
  const parts: string[] = [];
  if (row.expectedValue) parts.push(`期望 ${row.expectedValue}`);
  if (row.warnThreshold) parts.push(`橙 ${row.warnThreshold}`);
  if (row.errorThreshold) parts.push(`红 ${row.errorThreshold}`);
  return parts.length > 0 ? parts.join(' / ') : '—';
}

const RuleTab: React.FC = () => {
  const toast = useToast();
  const { dataSources, getTablesByDataSourceId, loading: dsLoading, error: dsError, refresh } = useDataSourceCache();

  // 数据源缓存目前只有数据探索模块在挂载时填充，质量面板可能先被打开，这里兜底拉一次
  const refreshRequestedRef = useRef(false);
  useEffect(() => {
    if (refreshRequestedRef.current || dsLoading || dataSources.length > 0) return;
    refreshRequestedRef.current = true;
    refresh();
  }, [dsLoading, dataSources.length, refresh]);

  const [treeKeyword, setTreeKeyword] = useState('');
  const [expandedDs, setExpandedDs] = useState<Set<number>>(new Set());
  const [expandedDb, setExpandedDb] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SelectedTable | null>(null);

  const [rules, setRules] = useState<QualityRuleVO[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesFailed, setRulesFailed] = useState(false);

  const [columns, setColumns] = useState<TableDetailColumn[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<RuleFormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<QualityRuleResultVO | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState<{ visible: boolean; message: string; onConfirm: () => void }>({
    visible: false,
    message: '',
    onConfirm: () => {},
  });

  // 按模板批量配置
  const [batchOpen, setBatchOpen] = useState(false);
  const [templates, setTemplates] = useState<QualityRuleTemplateVO[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [batchTemplateId, setBatchTemplateId] = useState<number | null>(null);
  const [batchTargets, setBatchTargets] = useState<Set<string>>(new Set());
  const [batchColumn, setBatchColumn] = useState('');
  const [batchKeyword, setBatchKeyword] = useState('');
  const [batchForm, setBatchForm] = useState({
    compareMode: 'GTE' as QualityCompareMode,
    expectedValue: '',
    warnThreshold: '',
    errorThreshold: '',
    disposeMode: 'ALERT' as QualityDisposeMode,
    ownerName: '',
    enabled: true,
  });
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  // 从设计文档导入（S2 稽核规则清单一键落库）
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importParsing, setImportParsing] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);

  /** 左树：数据源 → 库 → 表。库优先取数据源上声明的库名，缺失时用表清单反推 */
  const tree = useMemo(() => {
    const keyword = treeKeyword.trim().toLowerCase();
    return dataSources
      .map(ds => {
        const tables = getTablesByDataSourceId(ds.id).filter(hasDatabase);
        const declared = (ds.databaseName ?? []).filter(Boolean);
        const dbNames = declared.length > 0 ? declared : Array.from(new Set(tables.map(t => t.databaseName)));
        const dbs = dbNames
          .map(db => ({
            name: db,
            tables: tables.filter(t => t.databaseName === db && (!keyword || t.tableName.toLowerCase().includes(keyword))),
          }))
          .filter(db => !keyword || db.tables.length > 0);
        return { ds, dbs, tableCount: dbs.reduce((sum, db) => sum + db.tables.length, 0) };
      })
      .filter(node => !keyword || node.tableCount > 0);
  }, [dataSources, getTablesByDataSourceId, treeKeyword]);

  const loadRules = useCallback(async (target: SelectedTable | null) => {
    if (!target) {
      setRules([]);
      return;
    }
    setRulesLoading(true);
    try {
      const res = await qualityApi.listRules({
        datasourceId: target.datasourceId,
        databaseName: target.databaseName,
        tableName: target.tableName,
        size: 200,
      });
      setRules(res.data?.records ?? []);
      setRulesFailed(false);
    } catch {
      setRules([]);
      setRulesFailed(true);
    } finally {
      setRulesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules(selected);
  }, [selected, loadRules]);

  const selectTable = (target: SelectedTable) => {
    setSelected(target);
  };

  const openCreate = () => {
    if (!selected) {
      toast.warning('请先在左侧选择一张表');
      return;
    }
    const base = emptyForm();
    setForm({ ...base, refDatasourceId: selected.datasourceId });
    setTestResult(null);
    setDialogOpen(true);
  };

  const openEdit = (row: QualityRuleVO) => {
    setForm(toForm(row));
    setTestResult(null);
    setDialogOpen(true);
  };

  // 字段级规则的字段候选：随选中表懒加载
  useEffect(() => {
    if (!dialogOpen || !selected?.storageEngine) {
      setColumns([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchTableColumns(selected.storageEngine, selected.databaseName, selected.tableName);
        if (!cancelled) setColumns(res.data ?? []);
      } catch {
        if (!cancelled) setColumns([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, selected]);

  const scope = getQualityRuleType(form.ruleType)?.scope ?? 'COLUMN';

  /** 表单 → 保存入参。表信息来自左树，不接受手填，避免规则与库表树漂移 */
  const buildPayload = (): QualityRuleSaveDTO | null => {
    if (!selected) return null;
    return {
      id: form.id,
      ruleName: form.ruleName.trim(),
      ruleType: form.ruleType,
      templateId: null,
      // 内置模板编码与规则类型编码同名，未选模板时按类型落库
      templateCode: form.ruleType,
      datasourceId: selected.datasourceId,
      datasourceName: selected.datasourceName,
      databaseName: selected.databaseName,
      tableName: selected.tableName,
      columnName: scope === 'COLUMN' ? form.columnName : '',
      partitionExpr: form.partitionExpr.trim(),
      refDatasourceId: scope === 'PAIR' ? form.refDatasourceId : null,
      refDatabaseName: scope === 'PAIR' ? form.refDatabaseName.trim() : '',
      refTableName: scope === 'PAIR' ? form.refTableName.trim() : '',
      refColumnName: scope === 'PAIR' ? form.refColumnName.trim() : '',
      compareMode: form.compareMode,
      expectedValue: form.expectedValue.trim(),
      warnThreshold: form.warnThreshold.trim(),
      errorThreshold: form.errorThreshold.trim(),
      disposeMode: form.disposeMode,
      ownerName: form.ownerName.trim(),
      enabled: form.enabled,
    };
  };

  const validate = (): string | null => {
    if (!form.ruleName.trim()) return '请填写规则名称';
    if (scope === 'COLUMN' && !form.columnName) return '字段级规则需选择校验字段';
    if (scope === 'PAIR' && (!form.refDatabaseName.trim() || !form.refTableName.trim())) {
      return '跨表规则需填写对照库与对照表';
    }
    if (!form.expectedValue.trim() && !form.warnThreshold.trim() && !form.errorThreshold.trim()) {
      return '期望值与橙色/红色阈值至少填写一项，否则规则无法判定';
    }
    return null;
  };

  const handleTestRun = async () => {
    const invalid = validate();
    if (invalid) {
      toast.warning(invalid);
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    setTesting(true);
    try {
      const res = await qualityApi.testRunRule({ ruleId: form.id, rule: payload });
      setTestResult(res.data ?? null);
      if (!res.data) toast.warning('试跑未返回结果');
    } catch (e) {
      toast.error(`试跑失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    const invalid = validate();
    if (invalid) {
      toast.warning(invalid);
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    setSubmitting(true);
    try {
      if (form.id) await qualityApi.updateRule(payload);
      else await qualityApi.createRule(payload);
      setDialogOpen(false);
      toast.info(form.id ? '规则已更新' : '规则已创建');
      loadRules(selected);
    } catch (e) {
      toast.error(`${form.id ? '更新' : '创建'}失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleEnabled = async (row: QualityRuleVO) => {
    try {
      await qualityApi.updateRule({ ...toPayload(row), enabled: !row.enabled });
      toast.info(`「${row.ruleName}」已${row.enabled ? '停用' : '启用'}`);
      loadRules(selected);
    } catch (e) {
      toast.error(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDelete = (row: QualityRuleVO) => {
    setConfirm({
      visible: true,
      message: `确定要删除规则「${row.ruleName}」吗？历史校验结果留痕会保留，但规则不再出现在规则清单里。`,
      onConfirm: async () => {
        try {
          await qualityApi.deleteRule(row.id);
          toast.info(`「${row.ruleName}」已删除`);
          loadRules(selected);
        } catch (e) {
          toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        }
        setConfirm(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const openBatch = () => {
    if (!selected) {
      toast.warning('请先在左侧选择一张表所在的数据源');
      return;
    }
    setBatchTemplateId(null);
    setBatchTargets(new Set());
    setBatchColumn('');
    setBatchKeyword('');
    setBatchOpen(true);
    if (templates.length > 0) return;
    setTemplatesFailed(false);
    (async () => {
      try {
        const res = await qualityApi.listBuiltinTemplates();
        const list = res.data ?? [];
        setTemplates(list);
        if (list.length > 0) setBatchTemplateId(list[0].id);
      } catch {
        setTemplates([]);
        setTemplatesFailed(true);
      }
    })();
  };

  /** 批量配置的候选表：当前数据源下的全部表，字段名统一填写 */
  const batchCandidates = useMemo(() => {
    if (!selected) return [];
    const keyword = batchKeyword.trim().toLowerCase();
    return getTablesByDataSourceId(selected.datasourceId)
      .filter(hasDatabase)
      .filter(t => !keyword || t.tableName.toLowerCase().includes(keyword));
  }, [selected, getTablesByDataSourceId, batchKeyword]);

  const handleBatchSubmit = async () => {
    if (!selected) return;
    if (!batchTemplateId) {
      toast.warning('请选择规则模板');
      return;
    }
    if (batchTargets.size === 0) {
      toast.warning('请勾选目标表');
      return;
    }
    setBatchSubmitting(true);
    try {
      const res = await qualityApi.batchCreateRulesByTemplate({
        templateId: batchTemplateId,
        targets: batchCandidates
          .filter(t => batchTargets.has(`${t.databaseName}.${t.tableName}`))
          .map(t => ({
            datasourceId: selected.datasourceId,
            databaseName: t.databaseName,
            tableName: t.tableName,
            columnName: batchColumn.trim() || undefined,
          })),
        defaults: {
          compareMode: batchForm.compareMode,
          expectedValue: batchForm.expectedValue.trim(),
          warnThreshold: batchForm.warnThreshold.trim(),
          errorThreshold: batchForm.errorThreshold.trim(),
          disposeMode: batchForm.disposeMode,
          ownerName: batchForm.ownerName.trim(),
          enabled: batchForm.enabled,
        },
      });
      const created = res.data?.created ?? 0;
      const skipped = res.data?.skipped ?? 0;
      setBatchOpen(false);
      toast.info(`批量配置完成：新建 ${created} 条，跳过 ${skipped} 条`);
      loadRules(selected);
    } catch (e) {
      toast.error(`批量配置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBatchSubmitting(false);
    }
  };

  /** 元数据缓存拍平成候选表，供导入时按「库/表」反查数据源（设计文档只写库表，不写数据源） */
  const tableCandidates = useMemo(
    () =>
      dataSources.flatMap(ds =>
        getTablesByDataSourceId(ds.id)
          .filter(hasDatabase)
          .map(t => ({
            datasourceId: ds.id,
            datasourceName: ds.datasourceName,
            databaseName: t.databaseName,
            tableName: t.tableName,
          }))
      ),
    [dataSources, getTablesByDataSourceId]
  );

  const openImport = () => {
    setImportText('');
    setImportRows(null);
    setImportWarnings([]);
    setImportOpen(true);
  };

  /**
   * 解析粘贴的设计文档并做落库可行性判定：
   * 类型未识别 / 表未匹配 / 字段级缺字段 → 不可落库；该表已有同名规则 → 跳过。
   */
  const handleParseImport = async () => {
    if (!importText.trim()) {
      toast.warning('请先粘贴设计文档的「数据质量稽核设计」章节');
      return;
    }
    setImportParsing(true);
    const { rules, warnings } = parseQualityRulesFromDesignDoc(importText);

    const rows: ImportRow[] = rules.map(rule => {
      if (!rule.ruleType) {
        return { rule, columnName: rule.columnName, blocked: '规则类型不在 7 类统一术语内，需人工选择' };
      }
      const hit = matchQualityTable(tableCandidates, rule.databaseName, rule.tableName, rule.columnName);
      if (!hit) {
        return { rule, columnName: rule.columnName, blocked: '未匹配到库表，请先同步数据源元数据' };
      }
      if (rule.scope === 'COLUMN' && !hit.columnName) {
        return { rule, target: hit.target, columnName: '', blocked: '缺少校验字段，需人工补充' };
      }
      return { rule, target: hit.target, columnName: hit.columnName, blocked: '' };
    });

    // 已落库规则：按涉及的表各拉一次，用于标记同名重复（规则名是平台侧的唯一键）
    const targets = new Map<string, NonNullable<ImportRow['target']>>();
    for (const row of rows) {
      if (row.target) targets.set(`${row.target.datasourceId}:${row.target.databaseName}.${row.target.tableName}`, row.target);
    }
    const existing = new Map<string, Set<string>>();
    await Promise.all(
      Array.from(targets.entries()).map(async ([key, t]) => {
        try {
          const res = await qualityApi.listRules({
            datasourceId: t.datasourceId,
            databaseName: t.databaseName,
            tableName: t.tableName,
            size: 200,
          });
          existing.set(key, new Set((res.data?.records ?? []).map(r => r.ruleName)));
        } catch {
          existing.set(key, new Set());
        }
      })
    );
    for (const row of rows) {
      if (row.blocked || !row.target) continue;
      const key = `${row.target.datasourceId}:${row.target.databaseName}.${row.target.tableName}`;
      if (existing.get(key)?.has(row.rule.ruleName)) row.blocked = '该表已有同名规则，将跳过';
    }

    setImportRows(rows);
    setImportWarnings(warnings);
    setImportParsing(false);
  };

  const handleImportSubmit = async () => {
    const pending = (importRows ?? []).filter(r => !r.blocked && r.target);
    if (pending.length === 0) {
      toast.warning('没有可落库的规则');
      return;
    }
    setImportSubmitting(true);
    let created = 0;
    const failures: string[] = [];
    for (const row of pending) {
      const target = row.target!;
      try {
        await qualityApi.createRule({
          ruleName: row.rule.ruleName,
          ruleType: row.rule.ruleType,
          templateId: null,
          // 内置模板编码与规则类型编码同名，导入时按类型落库
          templateCode: row.rule.ruleType,
          datasourceId: target.datasourceId,
          datasourceName: target.datasourceName,
          databaseName: target.databaseName,
          tableName: target.tableName,
          columnName: row.columnName,
          partitionExpr: '',
          refDatasourceId: row.rule.scope === 'PAIR' ? target.datasourceId : null,
          refDatabaseName: row.rule.refDatabaseName,
          refTableName: row.rule.refTableName,
          refColumnName: row.rule.refColumnName,
          compareMode: row.rule.compareMode,
          expectedValue: row.rule.expectedValue,
          warnThreshold: '',
          errorThreshold: '',
          disposeMode: row.rule.disposeMode,
          ownerName: '',
          enabled: true,
        });
        created++;
      } catch (e) {
        failures.push(`${row.rule.ruleName}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setImportSubmitting(false);
    loadRules(selected);

    if (failures.length === 0) {
      toast.info(`已落库 ${created} 条规则草稿，请逐条核对阈值与处置方式`);
      setImportOpen(false);
      return;
    }
    // 部分失败：保留弹窗并重算状态，已落库的会因同名被标记为跳过，避免重复提交
    toast.error(`已落库 ${created} 条，${failures.length} 条失败：${failures[0]}`);
    await handleParseImport();
  };

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const toggleTable = (key: string) => {
    setBatchTargets(prev => toggleSet(prev, key));
  };

  const selectedRuleType = getQualityRuleType(form.ruleType);

  return (
    <div className="dq-rule-layout">
      {/* ── 左：库表树 ── */}
      <aside className="dq-tree">
        <div className="dq-tree__search">
          <Search size={13} />
          <input
            className="dq-tree__search-input"
            placeholder="搜索表名"
            value={treeKeyword}
            onChange={e => setTreeKeyword(e.target.value)}
          />
          <button className="dq-iconbtn" aria-label="刷新元数据" onClick={() => refresh()}>
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="dq-tree__body">
          {dsLoading && <div className="dq-muted dq-tree__hint">元数据加载中…</div>}
          {dsError && !dsLoading && (
            <div className="dq-tree__hint">
              <div className="dq-placeholder__head">
                <CircleAlert size={14} />
                <span>{dsError}</span>
              </div>
            </div>
          )}
          {!dsLoading && !dsError && dataSources.length === 0 && (
            <div className="dq-muted dq-tree__hint">未获取到数据源。请检查数据源配置后点击刷新。</div>
          )}
          {!dsLoading && !dsError && dataSources.length > 0 && tree.length === 0 && (
            <div className="dq-muted dq-tree__hint">没有匹配的表。请检查数据源与元数据同步情况。</div>
          )}
          {tree.map(node => {
            const dsOpen = expandedDs.has(node.ds.id);
            return (
              <div key={node.ds.id}>
                <div
                  className="dq-tree__node"
                  style={{ paddingLeft: 8 }}
                  onClick={() => setExpandedDs(prev => toggleSet(prev, node.ds.id))}
                >
                  <span className="dq-tree__chevron">
                    {node.dbs.length > 0 ? dsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
                  </span>
                  <span className="dq-tree__icon">
                    <Database size={13} />
                  </span>
                  <span className="dq-tree__label">{node.ds.datasourceName}</span>
                  <span className="dq-tree__count">{node.tableCount}</span>
                </div>
                {dsOpen &&
                  node.dbs.map(db => {
                    const dbKey = `${node.ds.id}:${db.name}`;
                    const dbOpen = expandedDb.has(dbKey);
                    return (
                      <div key={dbKey}>
                        <div
                          className="dq-tree__node"
                          style={{ paddingLeft: 22 }}
                          onClick={() => setExpandedDb(prev => toggleSet(prev, dbKey))}
                        >
                          <span className="dq-tree__chevron">
                            {dbOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </span>
                          <span className="dq-tree__icon">
                            <Layers3 size={13} />
                          </span>
                          <span className="dq-tree__label">{db.name}</span>
                          <span className="dq-tree__count">{db.tables.length}</span>
                        </div>
                        {dbOpen &&
                          db.tables.map(t => {
                            const active =
                              selected?.datasourceId === node.ds.id &&
                              selected.databaseName === t.databaseName &&
                              selected.tableName === t.tableName;
                            return (
                              <div
                                key={`${dbKey}.${t.tableName}`}
                                className={`dq-tree__node ${active ? 'dq-tree__node--active' : ''}`}
                                style={{ paddingLeft: 36 }}
                                onClick={() =>
                                  selectTable({
                                    datasourceId: node.ds.id,
                                    datasourceName: node.ds.datasourceName,
                                    databaseName: t.databaseName,
                                    tableName: t.tableName,
                                    storageEngine: t.storageEngine ?? '',
                                  })
                                }
                              >
                                <span className="dq-tree__chevron" />
                                <span className="dq-tree__icon">
                                  <Table2 size={13} />
                                </span>
                                <span className="dq-tree__label">{t.tableName}</span>
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── 右：规则清单 ── */}
      <main className="dq-rule-main">
        {!selected ? (
          <div className="dq-placeholder">
            <div className="dq-placeholder__head">
              <Table2 size={16} />
              <span>从左侧选择一张表，查看并配置它的监控规则。</span>
            </div>
            <p className="dq-placeholder__lead">
              规则类型固定为 7 类，字段级规则选字段、表级规则按整表判定、跨表规则需指定对照表。
            </p>
            <button className="dq-btn" onClick={openImport}>
              <FileUp size={14} /> 从设计文档导入规则
            </button>
          </div>
        ) : (
          <>
            <div className="dq-toolbar">
              <div>
                <h3 className="dq-rule-title">{selected.tableName}</h3>
                <p className="dq-muted dq-rule-subtitle">
                  {selected.datasourceName}.{selected.databaseName} · 已配置 {rules.length} 条规则
                </p>
              </div>
              <div className="dq-search-bar">
                <button className="dq-btn" onClick={() => loadRules(selected)}>
                  <RotateCcw size={14} /> 刷新
                </button>
                <button className="dq-btn" onClick={openImport}>
                  <FileUp size={14} /> 从设计文档导入
                </button>
                <button className="dq-btn" onClick={openBatch}>
                  <CopyPlus size={14} /> 按模板批量配置
                </button>
                <button className="dq-btn dq-btn--primary" onClick={openCreate}>
                  <Plus size={14} /> 新建规则
                </button>
              </div>
            </div>

            {rulesFailed ? (
              <div className="dq-placeholder">
                <div className="dq-placeholder__head">
                  <CircleAlert size={16} />
                  <span>规则接口不可用，暂时无法加载该表的规则。</span>
                </div>
                <p className="dq-placeholder__lead">
                  请确认服务端 /api/quality/rule 已部署且当前账号有权限，然后点击「刷新」重试。
                </p>
              </div>
            ) : (
              <table className="dq-table">
                <thead>
                  <tr>
                    <th>规则名</th>
                    <th>规则类型</th>
                    <th>校验对象</th>
                    <th>阈值</th>
                    <th>处置方式</th>
                    <th>状态</th>
                    <th className="dq-th-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rulesLoading ? (
                    <tr>
                      <td colSpan={7} className="dq-table-empty">
                        加载中…
                      </td>
                    </tr>
                  ) : rules.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="dq-table-empty">
                        该表尚未配置规则，点击「新建规则」开始配置。
                      </td>
                    </tr>
                  ) : (
                    rules.map(row => (
                      <tr key={row.id}>
                        <td className="dq-table__strong">
                          {row.ruleName}
                          {row.ownerName ? <span className="dq-table__sub">负责人 {row.ownerName}</span> : null}
                        </td>
                        <td>{getQualityRuleType(row.ruleType)?.label ?? row.ruleType}</td>
                        <td>
                          {row.columnName || '整表'}
                          {row.refTableName ? (
                            <span className="dq-table__sub">
                              对照 {row.refDatabaseName}.{row.refTableName}
                              {row.refColumnName ? `.${row.refColumnName}` : ''}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {COMPARE_LABEL[row.compareMode] ?? row.compareMode}
                          <span className="dq-table__sub">{thresholdText(row)}</span>
                        </td>
                        <td>{DISPOSE_LABEL[row.disposeMode] ?? row.disposeMode}</td>
                        <td>
                          <span className={`dq-tag dq-tag--${row.enabled ? 'success' : 'danger'}`}>
                            {row.enabled ? '启用' : '停用'}
                          </span>
                        </td>
                        <td className="dq-td-actions">
                          <button className="dq-btn-link" onClick={() => openEdit(row)}>
                            <Edit3 size={12} /> 编辑
                          </button>
                          <button className="dq-btn-link" onClick={() => handleToggleEnabled(row)}>
                            <Power size={12} /> {row.enabled ? '停用' : '启用'}
                          </button>
                          <button className="dq-btn-link dq-btn-link--danger" onClick={() => handleDelete(row)}>
                            <Trash2 size={12} /> 删除
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </>
        )}
      </main>

      {/* ── 规则编辑弹窗 ── */}
      {dialogOpen && selected && (
        <div className="dq-modal-overlay">
          <div className="dq-modal">
            <div className="dq-modal-header">
              <h3>{form.id ? '编辑规则' : '新建规则'}</h3>
              <button className="dq-modal-close" onClick={() => setDialogOpen(false)}>
                ×
              </button>
            </div>
            <div className="dq-modal-body">
              <p className="dq-muted dq-rule-subtitle">
                校验对象：{selected.datasourceName}.{selected.databaseName}.{selected.tableName}
              </p>

              <div className="dq-form-row">
                <div className="dq-form-group">
                  <label>
                    规则名称 <span className="dq-required">*</span>
                  </label>
                  <input
                    className="dq-input"
                    value={form.ruleName}
                    maxLength={128}
                    placeholder="如 订单主键唯一性校验"
                    onChange={e => setForm(f => ({ ...f, ruleName: e.target.value }))}
                  />
                </div>
                <div className="dq-form-group">
                  <label>
                    规则类型 <span className="dq-required">*</span>
                  </label>
                  <select
                    className="dq-select"
                    value={form.ruleType}
                    onChange={e =>
                      setForm(f => ({
                        ...f,
                        ruleType: e.target.value,
                        columnName: '',
                        refDatasourceId: f.refDatasourceId ?? selected.datasourceId,
                      }))
                    }
                  >
                    {QUALITY_RULE_TYPES.map(t => (
                      <option key={t.code} value={t.code}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {selectedRuleType && <p className="dq-hint">{selectedRuleType.desc}</p>}

              {scope === 'COLUMN' && (
                <div className="dq-form-group">
                  <label>
                    校验字段 <span className="dq-required">*</span>
                  </label>
                  <select
                    className="dq-select"
                    value={form.columnName}
                    onChange={e => setForm(f => ({ ...f, columnName: e.target.value }))}
                  >
                    <option value="">请选择字段</option>
                    {form.columnName && !columns.some(c => c.columnName === form.columnName) && (
                      <option value={form.columnName}>{form.columnName}（当前值）</option>
                    )}
                    {columns.map(c => (
                      <option key={c.columnName} value={c.columnName}>
                        {c.columnName}
                        {c.columnComment ? ` · ${c.columnComment}` : ''}
                      </option>
                    ))}
                  </select>
                  {columns.length === 0 && (
                    <p className="dq-hint">未取到字段清单（可能未同步元数据），可先在数据源管理同步后再配置。</p>
                  )}
                </div>
              )}

              {scope === 'PAIR' && (
                <div className="dq-form-group">
                  <label>
                    对照表 <span className="dq-required">*</span>
                  </label>
                  <div className="dq-form-row">
                    <select
                      className="dq-select"
                      value={form.refDatasourceId ?? ''}
                      onChange={e => setForm(f => ({ ...f, refDatasourceId: e.target.value ? Number(e.target.value) : null }))}
                    >
                      <option value="">对照数据源</option>
                      {dataSources.map(d => (
                        <option key={d.id} value={d.id}>
                          {d.datasourceName}
                        </option>
                      ))}
                    </select>
                    <input
                      className="dq-input"
                      placeholder="对照库名"
                      value={form.refDatabaseName}
                      onChange={e => setForm(f => ({ ...f, refDatabaseName: e.target.value }))}
                    />
                    <input
                      className="dq-input"
                      placeholder="对照表名"
                      value={form.refTableName}
                      onChange={e => setForm(f => ({ ...f, refTableName: e.target.value }))}
                    />
                    <input
                      className="dq-input"
                      placeholder="对照字段（可空）"
                      value={form.refColumnName}
                      onChange={e => setForm(f => ({ ...f, refColumnName: e.target.value }))}
                    />
                  </div>
                  <p className="dq-hint">跨表规则比对两张表的同口径结果，对照表需与校验对象粒度一致。</p>
                </div>
              )}

              <div className="dq-form-row">
                <div className="dq-form-group">
                  <label>比较方式</label>
                  <select
                    className="dq-select"
                    value={form.compareMode}
                    onChange={e => setForm(f => ({ ...f, compareMode: e.target.value as QualityCompareMode }))}
                  >
                    {COMPARE_MODES.map(m => (
                      <option key={m.code} value={m.code}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="dq-form-group">
                  <label>期望值</label>
                  <input
                    className="dq-input"
                    value={form.expectedValue}
                    placeholder="如 0 或 1000000"
                    onChange={e => setForm(f => ({ ...f, expectedValue: e.target.value }))}
                  />
                </div>
              </div>

              <div className="dq-form-row">
                <div className="dq-form-group">
                  <label>橙色阈值（警告）</label>
                  <input
                    className="dq-input"
                    value={form.warnThreshold}
                    placeholder="如 0.02 表示 2%"
                    onChange={e => setForm(f => ({ ...f, warnThreshold: e.target.value }))}
                  />
                </div>
                <div className="dq-form-group">
                  <label>红色阈值（错误）</label>
                  <input
                    className="dq-input"
                    value={form.errorThreshold}
                    placeholder="如 0.05 表示 5%"
                    onChange={e => setForm(f => ({ ...f, errorThreshold: e.target.value }))}
                  />
                </div>
              </div>
              <p className="dq-hint">期望值与两个阈值至少填一项；橙色仅告警，红色按处置方式决定是否阻断下游。</p>

              <div className="dq-form-row">
                <div className="dq-form-group">
                  <label>分区表达式</label>
                  <input
                    className="dq-input"
                    value={form.partitionExpr}
                    placeholder="如 dt=${yyyyMMdd}"
                    onChange={e => setForm(f => ({ ...f, partitionExpr: e.target.value }))}
                  />
                </div>
                <div className="dq-form-group">
                  <label>负责人</label>
                  <input
                    className="dq-input"
                    value={form.ownerName}
                    placeholder="异常时的责任人"
                    onChange={e => setForm(f => ({ ...f, ownerName: e.target.value }))}
                  />
                </div>
              </div>

              <div className="dq-form-row">
                <div className="dq-form-group">
                  <label>处置方式</label>
                  <div className="dq-switch">
                    {QUALITY_DISPOSE_MODES.map(m => (
                      <button
                        key={m.code}
                        className={`dq-switch-btn ${form.disposeMode === m.code ? 'dq-switch-btn--active' : ''}`}
                        onClick={() => setForm(f => ({ ...f, disposeMode: m.code }))}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dq-form-group">
                  <label>状态</label>
                  <div className="dq-switch">
                    <button
                      className={`dq-switch-btn ${form.enabled ? 'dq-switch-btn--active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, enabled: true }))}
                    >
                      启用
                    </button>
                    <button
                      className={`dq-switch-btn ${!form.enabled ? 'dq-switch-btn--active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, enabled: false }))}
                    >
                      停用
                    </button>
                  </div>
                </div>
              </div>

              {testResult && (
                <div className="dq-testresult">
                  <div className="dq-testresult__head">
                    <span className={`dq-tag dq-tag--${testResult.status === 'PASS' ? 'success' : testResult.status === 'FAILED' ? 'info' : 'warn'}`}>
                      {CHECK_STATUS_LABEL[testResult.status] ?? testResult.status}
                    </span>
                    <span className="dq-muted">
                      阈值 {testResult.threshold || '—'} · 实际值 {testResult.actualValue || '—'} · 耗时 {testResult.costMs}ms
                    </span>
                  </div>
                  {testResult.errorMsg && <p className="dq-testresult__error">{testResult.errorMsg}</p>}
                  {testResult.execSql && <pre className="dq-testresult__sql">{testResult.execSql}</pre>}
                </div>
              )}
            </div>
            <div className="dq-modal-footer">
              <button className="dq-btn" disabled={testing} onClick={handleTestRun}>
                <Play size={13} /> {testing ? '试跑中…' : '试跑'}
              </button>
              <div className="dq-modal-footer__spacer" />
              <button className="dq-btn" onClick={() => setDialogOpen(false)}>
                取消
              </button>
              <button className="dq-btn dq-btn--primary" disabled={submitting} onClick={handleSubmit}>
                {submitting ? '提交中…' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 按模板批量配置弹窗 ── */}
      {batchOpen && selected && (
        <div className="dq-modal-overlay">
          <div className="dq-modal">
            <div className="dq-modal-header">
              <h3>按模板批量配置</h3>
              <button className="dq-modal-close" onClick={() => setBatchOpen(false)}>
                ×
              </button>
            </div>
            <div className="dq-modal-body">
              {templatesFailed ? (
                <div className="dq-placeholder">
                  <div className="dq-placeholder__head">
                    <CircleAlert size={14} />
                    <span>规则模板接口不可用，无法批量配置。</span>
                  </div>
                  <p className="dq-placeholder__lead">请确认服务端 /api/quality/template/builtin 已部署。</p>
                </div>
              ) : (
                <>
                  <div className="dq-form-group">
                    <label>
                      规则模板 <span className="dq-required">*</span>
                    </label>
                    <select
                      className="dq-select"
                      value={batchTemplateId ?? ''}
                      onChange={e => setBatchTemplateId(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">请选择模板</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>
                          {t.templateName}（{getQualityRuleType(t.ruleType)?.label ?? t.ruleType}）
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="dq-form-group">
                    <label>统一字段名</label>
                    <input
                      className="dq-input"
                      value={batchColumn}
                      placeholder="字段级规则填各表同名字段，表级/跨表规则留空"
                      onChange={e => setBatchColumn(e.target.value)}
                    />
                  </div>

                  <div className="dq-form-group">
                    <label>
                      目标表（{batchTargets.size} / {batchCandidates.length}） <span className="dq-required">*</span>
                    </label>
                    <div className="dq-search-bar dq-search-bar--tight">
                      <input
                        className="dq-input"
                        placeholder="过滤表名"
                        value={batchKeyword}
                        onChange={e => setBatchKeyword(e.target.value)}
                      />
                      <button
                        className="dq-btn"
                        onClick={() => setBatchTargets(new Set(batchCandidates.map(t => `${t.databaseName}.${t.tableName}`)))}
                      >
                        全选
                      </button>
                      <button className="dq-btn" onClick={() => setBatchTargets(new Set())}>
                        清空
                      </button>
                    </div>
                    <div className="dq-picklist">
                      {batchCandidates.length === 0 ? (
                        <p className="dq-muted">没有匹配的表。</p>
                      ) : (
                        batchCandidates.map(t => {
                          const key = `${t.databaseName}.${t.tableName}`;
                          const on = batchTargets.has(key);
                          return (
                            <label className={`dq-picklist__item ${on ? 'dq-picklist__item--on' : ''}`} key={key}>
                              <input type="checkbox" checked={on} onChange={() => toggleTable(key)} />
                              <span>{key}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="dq-form-row">
                    <div className="dq-form-group">
                      <label>比较方式</label>
                      <select
                        className="dq-select"
                        value={batchForm.compareMode}
                        onChange={e => setBatchForm(f => ({ ...f, compareMode: e.target.value as QualityCompareMode }))}
                      >
                        {COMPARE_MODES.map(m => (
                          <option key={m.code} value={m.code}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="dq-form-group">
                      <label>期望值</label>
                      <input
                        className="dq-input"
                        value={batchForm.expectedValue}
                        onChange={e => setBatchForm(f => ({ ...f, expectedValue: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div className="dq-form-row">
                    <div className="dq-form-group">
                      <label>橙色阈值</label>
                      <input
                        className="dq-input"
                        value={batchForm.warnThreshold}
                        onChange={e => setBatchForm(f => ({ ...f, warnThreshold: e.target.value }))}
                      />
                    </div>
                    <div className="dq-form-group">
                      <label>红色阈值</label>
                      <input
                        className="dq-input"
                        value={batchForm.errorThreshold}
                        onChange={e => setBatchForm(f => ({ ...f, errorThreshold: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div className="dq-form-row">
                    <div className="dq-form-group">
                      <label>负责人</label>
                      <input
                        className="dq-input"
                        value={batchForm.ownerName}
                        onChange={e => setBatchForm(f => ({ ...f, ownerName: e.target.value }))}
                      />
                    </div>
                    <div className="dq-form-group">
                      <label>处置方式</label>
                      <div className="dq-switch">
                        {QUALITY_DISPOSE_MODES.map(m => (
                          <button
                            key={m.code}
                            className={`dq-switch-btn ${batchForm.disposeMode === m.code ? 'dq-switch-btn--active' : ''}`}
                            onClick={() => setBatchForm(f => ({ ...f, disposeMode: m.code }))}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <p className="dq-hint">
                    批量配置只覆盖当前数据源（{selected.datasourceName}）下的表，已存在同类型同字段的规则由服务端跳过。
                  </p>
                </>
              )}
            </div>
            <div className="dq-modal-footer">
              <button className="dq-btn" onClick={() => setBatchOpen(false)}>
                取消
              </button>
              <button
                className="dq-btn dq-btn--primary"
                disabled={batchSubmitting || templatesFailed}
                onClick={handleBatchSubmit}
              >
                {batchSubmitting ? '提交中…' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 从设计文档导入弹窗（S2 稽核规则清单一键落库） ── */}
      {importOpen && (
        <div className="dq-modal-overlay">
          <div className="dq-modal dq-modal--wide">
            <div className="dq-modal-header">
              <h3>从设计文档导入规则</h3>
              <button className="dq-modal-close" onClick={() => setImportOpen(false)}>
                ×
              </button>
            </div>
            <div className="dq-modal-body">
              <p className="dq-hint">
                粘贴 S2 数仓设计文档中的「数据质量稽核设计」章节（含稽核规则清单表格）。平台按表头列名解析，
                规则类型须逐字取自 7 类统一术语；解析结果先预览，确认后再落库为规则草稿。
              </p>

              <div className="dq-form-group">
                <label>设计文档章节内容</label>
                <textarea
                  className="dq-textarea"
                  rows={8}
                  value={importText}
                  placeholder={'## 6. 数据质量稽核设计\n\n| 规则名 | 规则类型 | 校验对象（库.表.字段） | 阈值 | 处置方式 |\n|---|---|---|---|---|'}
                  onChange={e => setImportText(e.target.value)}
                  disabled={importParsing || importSubmitting}
                />
              </div>

              <div className="dq-search-bar dq-search-bar--tight">
                <button className="dq-btn" disabled={importParsing || importSubmitting} onClick={handleParseImport}>
                  {importParsing ? '解析中…' : '解析'}
                </button>
                {importRows && (
                  <span className="dq-muted">
                    共解析 {importRows.length} 条，可落库 {importRows.filter(r => !r.blocked).length} 条
                  </span>
                )}
              </div>

              {importWarnings.length > 0 && (
                <div className="dq-placeholder">
                  <div className="dq-placeholder__head">
                    <CircleAlert size={14} />
                    <span>解析告警（{importWarnings.length} 条）</span>
                  </div>
                  {importWarnings.map((w, i) => (
                    <p className="dq-placeholder__lead" key={i}>
                      {w}
                    </p>
                  ))}
                </div>
              )}

              {importRows && (
                <table className="dq-table">
                  <thead>
                    <tr>
                      <th>规则名</th>
                      <th>规则类型</th>
                      <th>校验对象</th>
                      <th>阈值</th>
                      <th>处置方式</th>
                      <th>落库状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="dq-table-empty">
                          未从粘贴内容中解析出规则，请确认章节标题含「质量/稽核/规则」且规则表含「规则名」「规则类型」列。
                        </td>
                      </tr>
                    ) : (
                      importRows.map((row, i) => {
                        const t = row.target;
                        const objectText = t
                          ? `${t.databaseName}.${t.tableName}${row.columnName ? `.${row.columnName}` : ' · 整表'}`
                          : `${row.rule.databaseName ? `${row.rule.databaseName}.` : ''}${row.rule.tableName}${
                              row.rule.columnName ? `.${row.rule.columnName}` : ''
                            }`;
                        return (
                          <tr key={`${row.rule.ruleName}-${i}`}>
                            <td className="dq-table__strong">
                              {row.rule.ruleName}
                              {row.rule.warnings.length > 0 ? (
                                <span className="dq-table__sub">{row.rule.warnings.join('；')}</span>
                              ) : null}
                            </td>
                            <td>{getQualityRuleType(row.rule.ruleType)?.label ?? row.rule.ruleType ?? '未识别'}</td>
                            <td>
                              {objectText}
                              {row.rule.refTableName ? (
                                <span className="dq-table__sub">
                                  对照 {row.rule.refDatabaseName ? `${row.rule.refDatabaseName}.` : ''}
                                  {row.rule.refTableName}
                                  {row.rule.refColumnName ? `.${row.rule.refColumnName}` : ''}
                                </span>
                              ) : null}
                              {t ? <span className="dq-table__sub">{t.datasourceName}</span> : null}
                            </td>
                            <td>
                              {row.rule.compareMode
                                ? COMPARE_LABEL[row.rule.compareMode] ?? row.rule.compareMode
                                : '—'}
                              <span className="dq-table__sub">
                                {row.rule.expectedValue ? `期望 ${row.rule.expectedValue}` : '未解析出阈值'}
                              </span>
                            </td>
                            <td>{DISPOSE_LABEL[row.rule.disposeMode] ?? row.rule.disposeMode}</td>
                            <td>
                              <span className={`dq-tag dq-tag--${row.blocked ? 'danger' : 'success'}`}>
                                {row.blocked ? '不可落库' : '待落库'}
                              </span>
                              {row.blocked ? <span className="dq-table__sub">{row.blocked}</span> : null}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              )}
            </div>
            <div className="dq-modal-footer">
              <button className="dq-btn" onClick={() => setImportOpen(false)}>
                取消
              </button>
              <button
                className="dq-btn dq-btn--primary"
                disabled={importSubmitting || (importRows ?? []).every(r => r.blocked)}
                onClick={handleImportSubmit}
              >
                {importSubmitting
                  ? '落库中…'
                  : `落库 ${(importRows ?? []).filter(r => !r.blocked).length} 条`}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm.visible && (
        <div className="dq-modal-overlay">
          <div className="dq-confirm-dialog">
            <h3>确认删除</h3>
            <p>{confirm.message}</p>
            <div className="dq-confirm-actions">
              <button className="dq-btn" onClick={() => setConfirm(prev => ({ ...prev, visible: false }))}>
                取消
              </button>
              <button className="dq-btn dq-btn--danger" onClick={confirm.onConfirm}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RuleTab;
