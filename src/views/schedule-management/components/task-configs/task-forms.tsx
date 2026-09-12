import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  DSLocalParam, DSHttpParam, DSDatasource, DSTaskType,
  DSShellTaskParams, DSSqlTaskParams, DSPythonTaskParams,
  DSDataXTaskParams, DSSparkTaskParams, DSFlinkTaskParams,
  DSHttpTaskParams, DSSubProcessTaskParams, DSProcedureTaskParams,
  DSMrTaskParams, DSDependentTaskParams, DSDependentTaskModel, DSDependentTaskItem, DSConditionsTaskParams,
  DSSwitchTaskParams, DSSeaTunnelTaskParams, DSK8sTaskParams,
  DSJavaTaskParams, DSWorkflowTaskNode,
  DSFlinkStreamTaskParams, DSSqoopTaskParams, DSGrpcTaskParams,
  DSEmrTaskParams, DSZeppelinTaskParams, DSJupyterTaskParams,
  DSMlflowTaskParams, DSOpenmldbTaskParams, DSDvcTaskParams,
  DSDinkyTaskParams, DSSagemakerTaskParams, DSChunjunTaskParams,
  DSHiveCliTaskParams, DSDmsTaskParams, DSDatasyncTaskParams,
  DSKubeflowTaskParams, DSLinkisTaskParams, DSDataFactoryTaskParams,
  DSRemoteShellTaskParams, DSAliyunServerlessSparkTaskParams,
  DolphinSchedulerApi,
} from '../../../../types/dolphinscheduler';
import {
  DATASOURCE_TYPES, MOCK_DATASOURCES,
} from '../../../../types/dolphinscheduler';
import { ResourceSelect } from './ResourceSelect';

interface TaskFormProps<T> {
  params: T;
  onChange: (params: T) => void;
  allNodes: DSWorkflowTaskNode[];
  currentCode: number;
  workflowDefinitions?: { code: number; name: string }[];
  api?: DolphinSchedulerApi;
  /**
   * 「应用名称」的自动值（`{project}.{workflow}.{task}`，见 utils/appName.ts）。
   * 传入时该字段渲染为**只读**并展示此值（提交入口传，保证与工作流基本信息一致）；
   * 不传时保持可编辑（调度管理里编辑已有工作流，允许沿用历史手工值）。
   */
  appName?: string;
}

/**
 * 「应用名称」输入项。
 *
 * 传了 `autoValue`（由项目 / 工作流 / 任务名派生的拼接值）时只读展示，
 * 否则退化成普通可编辑输入框 —— 字段位置与文案在两种模式下完全一致。
 */
function AppNameField({
  autoValue, value, placeholder, onChange,
}: {
  autoValue?: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  if (autoValue !== undefined) {
    return (
      <div className="tc-field">
        <label>应用名称</label>
        <input
          type="text"
          value={autoValue}
          readOnly
          disabled
          title={autoValue}
          data-testid="task-app-name"
        />
        <div className="tc-help-text">由「项目.工作流.任务」自动生成，与工作流基本信息保持一致</div>
      </div>
    );
  }
  return (
    <div className="tc-field">
      <label>应用名称</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function LocalParamsEditor({ params, onChange }: { params: DSLocalParam[]; onChange: (p: DSLocalParam[]) => void }) {
  const add = () => onChange([...params, { prop: '', direct: 'IN', type: 'VARCHAR', value: '' }]);
  const remove = (i: number) => onChange(params.filter((_, idx) => idx !== i));
  const update = (i: number, field: keyof DSLocalParam, value: string) => {
    const next = [...params];
    next[i] = { ...next[i], [field]: value };
    onChange(next);
  };

  return (
    <div className="tc-dynamic-list">
      {params.length > 0 && (
        <table className="tc-params-table">
          <thead>
            <tr>
              <th>参数名</th>
              <th>方向</th>
              <th>类型</th>
              <th>参数值</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {params.map((p, i) => (
              <tr key={i}>
                <td><input type="text" value={p.prop} onChange={e => update(i, 'prop', e.target.value)} placeholder="参数名" /></td>
                <td>
                  <select value={p.direct} onChange={e => update(i, 'direct', e.target.value)}>
                    <option value="IN">IN</option>
                    <option value="OUT">OUT</option>
                  </select>
                </td>
                <td>
                  <select value={p.type} onChange={e => update(i, 'type', e.target.value)}>
                    {['VARCHAR', 'INTEGER', 'LONG', 'FLOAT', 'DOUBLE', 'DATE', 'TIME', 'BOOLEAN', 'LIST', 'FILE'].map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td><input type="text" value={p.value} onChange={e => update(i, 'value', e.target.value)} placeholder="参数值" /></td>
                <td><button className="tc-dynamic-list__remove" onClick={() => remove(i)}><X size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="tc-dynamic-list__add" onClick={add}><Plus size={12} /> 添加自定义参数</button>
    </div>
  );
}

function StatementsEditor({ items, onChange, label }: { items: string[]; onChange: (s: string[]) => void; label: string }) {
  const add = () => onChange([...items, '']);
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const update = (i: number, val: string) => {
    const next = [...items];
    next[i] = val;
    onChange(next);
  };

  return (
    <div className="tc-statements">
      {items.map((s, i) => (
        <div key={i} className="tc-statements__item">
          <textarea value={s} onChange={e => update(i, e.target.value)} placeholder={label} />
          <button className="tc-dynamic-list__remove" onClick={() => remove(i)}><X size={12} /></button>
        </div>
      ))}
      <button className="tc-dynamic-list__add" onClick={add}><Plus size={12} /> 添加{label}</button>
    </div>
  );
}

function DatasourceSelect({ value, typeValue, onChange, onTypeChange, datasources, label }: {
  value: number; typeValue: string; onChange: (v: number) => void;
  onTypeChange: (v: string) => void; datasources: DSDatasource[]; label: string;
}) {
  const filtered = typeValue ? datasources.filter(d => d.type === typeValue) : datasources;
  return (
    <div className="tc-datasource-row">
      <select value={typeValue} onChange={e => onTypeChange(e.target.value)} style={{ maxWidth: 140 }}>
        <option value="">选择类型</option>
        {DATASOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={value} onChange={e => onChange(Number(e.target.value))}>
        <option value={0}>选择{label}</option>
        {filtered.map(d => <option key={d.code} value={d.code}>{d.name}</option>)}
      </select>
    </div>
  );
}

export function ShellForm({ params, onChange }: TaskFormProps<DSShellTaskParams>) {
  const set = <K extends keyof DSShellTaskParams>(key: K, val: DSShellTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>CPU配额</label>
          <input type="number" value={params.cpuQuota} onChange={e => set('cpuQuota', parseInt(e.target.value) || -1)} min={-1} />
          <div className="tc-help-text">-1 表示不限制</div>
        </div>
        <div className="tc-field">
          <label>最大内存(MB)</label>
          <input type="number" value={params.memoryMax} onChange={e => set('memoryMax', parseInt(e.target.value) || -1)} min={-1} />
          <div className="tc-help-text">-1 表示不限制</div>
        </div>
      </div>
      <div className="tc-field">
        <label>脚本<span className="sm-required">*</span></label>
        <textarea
          className="tc-code"
          value={params.rawScript}
          onChange={e => set('rawScript', e.target.value)}
          placeholder="#!/bin/bash&#10;echo 'Hello World'"
          rows={8}
        />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function PythonForm({ params, onChange }: TaskFormProps<DSPythonTaskParams>) {
  const set = <K extends keyof DSPythonTaskParams>(key: K, val: DSPythonTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>脚本<span className="sm-required">*</span></label>
        <textarea
          className="tc-code"
          value={params.rawScript}
          onChange={e => set('rawScript', e.target.value)}
          placeholder="print('Hello World')"
          rows={8}
        />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>CPU配额</label>
          <input type="number" value={params.cpuQuota} onChange={e => set('cpuQuota', parseInt(e.target.value) || -1)} min={-1} />
          <div className="tc-help-text">-1 表示不限制</div>
        </div>
        <div className="tc-field">
          <label>最大内存(MB)</label>
          <input type="number" value={params.memoryMax} onChange={e => set('memoryMax', parseInt(e.target.value) || -1)} min={-1} />
          <div className="tc-help-text">-1 表示不限制</div>
        </div>
      </div>
    </>
  );
}

export function SqlForm({ params, onChange }: TaskFormProps<DSSqlTaskParams>) {
  const set = <K extends keyof DSSqlTaskParams>(key: K, val: DSSqlTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>数据源</label>
        <DatasourceSelect
          value={params.datasource}
          typeValue={params.type}
          onChange={v => set('datasource', v)}
          onTypeChange={v => set('type', v)}
          datasources={MOCK_DATASOURCES}
          label="数据源"
        />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>SQL类型</label>
          <div className="tc-radio-group">
            <label className="tc-radio">
              <input type="radio" name="sqlType" checked={params.sqlType === '0'} onChange={() => set('sqlType', '0')} />
              <span>查询</span>
            </label>
            <label className="tc-radio">
              <input type="radio" name="sqlType" checked={params.sqlType === '1'} onChange={() => set('sqlType', '1')} />
              <span>非查询</span>
            </label>
          </div>
        </div>
        {params.sqlType === '0' && (
          <div className="tc-field">
            <label>显示行数</label>
            <input type="number" value={params.displayRows} onChange={e => set('displayRows', parseInt(e.target.value) || 10)} min={1} />
          </div>
        )}
      </div>
      {params.type === 'HIVE' && (
        <div className="tc-field">
          <label>连接参数</label>
          <input type="text" value={params.connParams} onChange={e => set('connParams', e.target.value)} placeholder="Hive连接参数" />
        </div>
      )}
      <div className="tc-field">
        <label>SQL语句<span className="sm-required">*</span></label>
        <textarea
          className="tc-code"
          value={params.sql}
          onChange={e => set('sql', e.target.value)}
          placeholder="SELECT * FROM table_name WHERE dt = '${biz_date}'"
          rows={8}
        />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
      <div className="tc-field">
        <label>前置SQL</label>
        <StatementsEditor items={params.preStatements} onChange={s => set('preStatements', s)} label="前置SQL语句" />
      </div>
      <div className="tc-field">
        <label>后置SQL</label>
        <StatementsEditor items={params.postStatements} onChange={s => set('postStatements', s)} label="后置SQL语句" />
      </div>
    </>
  );
}

export function ProcedureForm({ params, onChange }: TaskFormProps<DSProcedureTaskParams>) {
  const set = <K extends keyof DSProcedureTaskParams>(key: K, val: DSProcedureTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>数据源</label>
        <DatasourceSelect
          value={params.datasource}
          typeValue={params.type}
          onChange={v => set('datasource', v)}
          onTypeChange={v => set('type', v)}
          datasources={MOCK_DATASOURCES}
          label="数据源"
        />
      </div>
      <div className="tc-field">
        <label>存储过程语句<span className="sm-required">*</span></label>
        <textarea
          className="tc-code"
          value={params.method}
          onChange={e => set('method', e.target.value)}
          placeholder="CALL procedure_name(param1, param2)"
          rows={6}
        />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function DataXForm({ params, onChange }: TaskFormProps<DSDataXTaskParams>) {
  const set = <K extends keyof DSDataXTaskParams>(key: K, val: DSDataXTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label className="tc-switch">
          <input type="checkbox" checked={params.customConfig} onChange={e => set('customConfig', e.target.checked)} />
          <span>使用自定义JSON模板</span>
        </label>
      </div>
      {params.customConfig ? (
        <>
          <div className="tc-field">
            <label>JSON模板<span className="sm-required">*</span></label>
            <textarea
              className="tc-code"
              value={params.json}
              onChange={e => set('json', e.target.value)}
              placeholder='{"job":{"content":[],"setting":{}}}'
              rows={12}
            />
          </div>
        </>
      ) : (
        <>
          <div className="tc-field">
            <label>源数据源</label>
            <DatasourceSelect
              value={params.datasource}
              typeValue={params.dsType}
              onChange={v => set('datasource', v)}
              onTypeChange={v => set('dsType', v)}
              datasources={MOCK_DATASOURCES}
              label="源数据源"
            />
          </div>
          <div className="tc-field">
            <label>SQL抽取语句<span className="sm-required">*</span></label>
            <textarea
              className="tc-code"
              value={params.sql}
              onChange={e => set('sql', e.target.value)}
              placeholder="SELECT * FROM source_table WHERE dt = '${biz_date}'"
              rows={6}
            />
          </div>
          <div className="tc-field">
            <label>目标数据源</label>
            <DatasourceSelect
              value={params.dtDatasource}
              typeValue={params.dtType}
              onChange={v => set('dtDatasource', v)}
              onTypeChange={v => set('dtType', v)}
              datasources={MOCK_DATASOURCES}
              label="目标数据源"
            />
          </div>
          <div className="tc-field">
            <label>目标表名<span className="sm-required">*</span></label>
            <input type="text" value={params.targetTable} onChange={e => set('targetTable', e.target.value)} placeholder="target_table" />
          </div>
          <div className="tc-field">
            <label>前置SQL</label>
            <StatementsEditor items={params.preStatements} onChange={s => set('preStatements', s)} label="前置SQL语句" />
          </div>
          <div className="tc-field">
            <label>后置SQL</label>
            <StatementsEditor items={params.postStatements} onChange={s => set('postStatements', s)} label="后置SQL语句" />
          </div>
          <div className="tc-row">
            <div className="tc-field">
              <label>限流(字节)</label>
              <input type="number" value={params.jobSpeedByte} onChange={e => set('jobSpeedByte', parseInt(e.target.value) || 0)} min={0} />
              <div className="tc-help-text">0 表示不限流</div>
            </div>
            <div className="tc-field">
              <label>限流(记录数)</label>
              <input type="number" value={params.jobSpeedRecord} onChange={e => set('jobSpeedRecord', parseInt(e.target.value) || 0)} min={0} />
            </div>
          </div>
          <div className="tc-row">
            <div className="tc-field">
              <label>JVM最小内存(GB)</label>
              <input type="number" value={params.xms} onChange={e => set('xms', parseInt(e.target.value) || 1)} min={1} />
            </div>
            <div className="tc-field">
              <label>JVM最大内存(GB)</label>
              <input type="number" value={params.xmx} onChange={e => set('xmx', parseInt(e.target.value) || 1)} min={1} />
            </div>
          </div>
        </>
      )}
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function SparkForm({ params, onChange, api, appName }: TaskFormProps<DSSparkTaskParams>) {
  const set = <K extends keyof DSSparkTaskParams>(key: K, val: DSSparkTaskParams[K]) =>
    onChange({ ...params, [key]: val });
  const isSql = params.programType === 'SQL';

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>程序类型</label>
          <select value={params.programType} onChange={e => set('programType', e.target.value as DSSparkTaskParams['programType'])}>
            <option value="JAVA">JAVA</option>
            <option value="SCALA">SCALA</option>
            <option value="PYTHON">PYTHON</option>
            <option value="SQL">SQL</option>
          </select>
        </div>
        {isSql && (
          <div className="tc-field">
            <label>SQL执行类型</label>
            <select value={params.sqlExecutionType} onChange={e => set('sqlExecutionType', e.target.value as 'SCRIPT' | 'FILE')}>
              <option value="SCRIPT">脚本</option>
              <option value="FILE">文件</option>
            </select>
          </div>
        )}
      </div>
      {!isSql && (
        <div className="tc-field">
          <label>主Class</label>
          <input type="text" value={params.mainClass} onChange={e => set('mainClass', e.target.value)} placeholder="com.example.MainClass" />
        </div>
      )}
      {api ? (
        <ResourceSelect
          value={params.mainJar}
          onChange={(val) => set('mainJar', val)}
          api={api}
          label="主Jar包"
          placeholder="请选择主Jar包"
        />
      ) : (
        <div className="tc-field">
          <label>主Jar包</label>
          <input type="text" value={params.mainJar} onChange={e => set('mainJar', e.target.value)} placeholder="hdfs:///path/to/jar" />
        </div>
      )}
      {isSql && params.sqlExecutionType === 'SCRIPT' && (
        <div className="tc-field">
          <label>SQL脚本</label>
          <textarea className="tc-code" value={params.rawScript} onChange={e => set('rawScript', e.target.value)} placeholder="SELECT * FROM table" rows={6} />
        </div>
      )}
      <div className="tc-row">
        <div className="tc-field">
          <label>Master</label>
          <input type="text" value={params.master} onChange={e => set('master', e.target.value)} placeholder="yarn / spark://host:port" />
        </div>
        <div className="tc-field">
          <label>部署模式</label>
          <select value={params.deployMode} onChange={e => set('deployMode', e.target.value)}>
            <option value="cluster">cluster</option>
            <option value="client">client</option>
            <option value="local">local</option>
          </select>
        </div>
      </div>
      <AppNameField
        autoValue={appName}
        value={params.appName}
        placeholder="Spark Application"
        onChange={v => set('appName', v)}
      />
      <div className="tc-row">
        <div className="tc-field">
          <label>Driver核心数</label>
          <input type="number" value={params.driverCores} onChange={e => set('driverCores', parseInt(e.target.value) || 1)} min={1} />
        </div>
        <div className="tc-field">
          <label>Driver内存</label>
          <input type="text" value={params.driverMemory} onChange={e => set('driverMemory', e.target.value)} placeholder="512M" />
        </div>
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>Executor数量</label>
          <input type="number" value={params.numExecutors} onChange={e => set('numExecutors', parseInt(e.target.value) || 2)} min={1} />
        </div>
        <div className="tc-field">
          <label>Executor内存</label>
          <input type="text" value={params.executorMemory} onChange={e => set('executorMemory', e.target.value)} placeholder="2G" />
        </div>
      </div>
      <div className="tc-field">
        <label>Executor核心数</label>
        <input type="number" value={params.executorCores} onChange={e => set('executorCores', parseInt(e.target.value) || 2)} min={1} />
      </div>
      <div className="tc-field">
        <label>YARN队列</label>
        <input type="text" value={params.yarnQueue} onChange={e => set('yarnQueue', e.target.value)} placeholder="default" />
      </div>
      <div className="tc-field">
        <label>主参数</label>
        <textarea value={params.mainArgs} onChange={e => set('mainArgs', e.target.value)} placeholder="程序运行参数" rows={3} />
      </div>
      <div className="tc-field">
        <label>其他参数</label>
        <textarea value={params.others} onChange={e => set('others', e.target.value)} placeholder="--conf spark.xxx=yyy" rows={2} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function FlinkForm({ params, onChange, api, appName }: TaskFormProps<DSFlinkTaskParams>) {
  const set = <K extends keyof DSFlinkTaskParams>(key: K, val: DSFlinkTaskParams[K]) =>
    onChange({ ...params, [key]: val });
  const isSql = params.programType === 'SQL';

  return (
    <>
      <div className="tc-field">
        <label>程序类型</label>
        <select value={params.programType} onChange={e => set('programType', e.target.value as DSFlinkTaskParams['programType'])}>
          <option value="JAVA">JAVA</option>
          <option value="SCALA">SCALA</option>
          <option value="PYTHON">PYTHON</option>
          <option value="SQL">SQL</option>
        </select>
      </div>
      {!isSql && (
        <div className="tc-field">
          <label>主Class</label>
          <input type="text" value={params.mainClass} onChange={e => set('mainClass', e.target.value)} placeholder="com.example.MainClass" />
        </div>
      )}
      {api ? (
        <ResourceSelect
          value={params.mainJar}
          onChange={(val) => set('mainJar', val)}
          api={api}
          label="主Jar包"
          placeholder="请选择主Jar包"
        />
      ) : (
        <div className="tc-field">
          <label>主Jar包</label>
          <input type="text" value={params.mainJar} onChange={e => set('mainJar', e.target.value)} placeholder="hdfs:///path/to/jar" />
        </div>
      )}
      <div className="tc-field">
        <label>部署模式</label>
        <select value={params.deployMode} onChange={e => set('deployMode', e.target.value)}>
          {isSql ? (
            <>
              <option value="cluster">cluster</option>
              <option value="local">local</option>
              <option value="standalone">standalone</option>
            </>
          ) : (
            <>
              <option value="cluster">cluster</option>
              <option value="application">application</option>
              <option value="local">local</option>
            </>
          )}
        </select>
      </div>
      {isSql && (
        <>
          <div className="tc-field">
            <label>初始化脚本</label>
            <textarea className="tc-code" value={params.initScript} onChange={e => set('initScript', e.target.value)} placeholder="SET table.sql-dialect=default;" rows={4} />
          </div>
          <div className="tc-field">
            <label>SQL脚本<span className="sm-required">*</span></label>
            <textarea className="tc-code" value={params.rawScript} onChange={e => set('rawScript', e.target.value)} placeholder="INSERT INTO target SELECT * FROM source" rows={8} />
          </div>
        </>
      )}
      <div className="tc-field">
        <label>Flink版本</label>
        <select value={params.flinkVersion} onChange={e => set('flinkVersion', e.target.value)}>
          <option value="&lt;1.10">&lt;1.10</option>
          <option value="1.10-1.12">1.10-1.12</option>
          <option value="&gt;=1.12">&gt;=1.12</option>
        </select>
      </div>
      <AppNameField
        autoValue={appName}
        value={params.appName}
        placeholder="Flink Application"
        onChange={v => set('appName', v)}
      />
      <div className="tc-row">
        <div className="tc-field">
          <label>JobManager内存</label>
          <input type="text" value={params.jobManagerMemory} onChange={e => set('jobManagerMemory', e.target.value)} placeholder="1G" />
        </div>
        <div className="tc-field">
          <label>TaskManager内存</label>
          <input type="text" value={params.taskManagerMemory} onChange={e => set('taskManagerMemory', e.target.value)} placeholder="2G" />
        </div>
      </div>
      <div className="tc-row tc-row--3">
        <div className="tc-field">
          <label>Slot数</label>
          <input type="number" value={params.slot} onChange={e => set('slot', parseInt(e.target.value) || 1)} min={1} />
        </div>
        <div className="tc-field">
          <label>TaskManager数</label>
          <input type="number" value={params.taskManager} onChange={e => set('taskManager', parseInt(e.target.value) || 2)} min={1} />
        </div>
        <div className="tc-field">
          <label>并行度</label>
          <input type="number" value={params.parallelism} onChange={e => set('parallelism', parseInt(e.target.value) || 1)} min={1} />
        </div>
      </div>
      <div className="tc-field">
        <label>YARN队列</label>
        <input type="text" value={params.yarnQueue} onChange={e => set('yarnQueue', e.target.value)} placeholder="default" />
      </div>
      <div className="tc-field">
        <label>主参数</label>
        <textarea value={params.mainArgs} onChange={e => set('mainArgs', e.target.value)} placeholder="程序运行参数" rows={3} />
      </div>
      <div className="tc-field">
        <label>其他参数</label>
        <textarea value={params.others} onChange={e => set('others', e.target.value)} placeholder="-Dkey=value" rows={2} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function MrForm({ params, onChange, api, appName }: TaskFormProps<DSMrTaskParams>) {
  const set = <K extends keyof DSMrTaskParams>(key: K, val: DSMrTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>程序类型</label>
        <select value={params.programType} onChange={e => set('programType', e.target.value as DSMrTaskParams['programType'])}>
          <option value="JAVA">JAVA</option>
          <option value="SCALA">SCALA</option>
          <option value="PYTHON">PYTHON</option>
        </select>
      </div>
      {params.programType !== 'PYTHON' && (
        <div className="tc-field">
          <label>主Class</label>
          <input type="text" value={params.mainClass} onChange={e => set('mainClass', e.target.value)} placeholder="com.example.MainClass" />
        </div>
      )}
      {api ? (
        <ResourceSelect
          value={params.mainJar}
          onChange={(val) => set('mainJar', val)}
          api={api}
          label="主Jar包"
          placeholder="请选择主Jar包"
        />
      ) : (
        <div className="tc-field">
          <label>主Jar包</label>
          <input type="text" value={params.mainJar} onChange={e => set('mainJar', e.target.value)} placeholder="hdfs:///path/to/jar" />
        </div>
      )}
      <AppNameField
        autoValue={appName}
        value={params.appName}
        placeholder="MapReduce Application"
        onChange={v => set('appName', v)}
      />
      <div className="tc-field">
        <label>主参数</label>
        <textarea value={params.mainArgs} onChange={e => set('mainArgs', e.target.value)} placeholder="程序运行参数" rows={3} />
      </div>
      <div className="tc-field">
        <label>YARN队列</label>
        <input type="text" value={params.yarnQueue} onChange={e => set('yarnQueue', e.target.value)} placeholder="default" />
      </div>
      <div className="tc-field">
        <label>其他参数</label>
        <textarea value={params.others} onChange={e => set('others', e.target.value)} placeholder="-Dmapred.xxx=yyy" rows={2} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function HttpForm({ params, onChange }: TaskFormProps<DSHttpTaskParams>) {
  const set = <K extends keyof DSHttpTaskParams>(key: K, val: DSHttpTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  const addParam = () => onChange({ ...params, httpParams: [...params.httpParams, { prop: '', httpParametersType: 'PARAMETER', value: '' }] });
  const removeParam = (i: number) => onChange({ ...params, httpParams: params.httpParams.filter((_, idx) => idx !== i) });
  const updateParam = (i: number, field: keyof DSHttpParam, value: string) => {
    const next = [...params.httpParams];
    next[i] = { ...next[i], [field]: value };
    onChange({ ...params, httpParams: next });
  };

  return (
    <>
      <div className="tc-field">
        <label>请求地址<span className="sm-required">*</span></label>
        <input type="text" value={params.url} onChange={e => set('url', e.target.value)} placeholder="http://example.com/api" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>请求类型</label>
          <select value={params.httpMethod} onChange={e => set('httpMethod', e.target.value as DSHttpTaskParams['httpMethod'])}>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>
        <div className="tc-field">
          <label>校验条件</label>
          <select value={params.httpCheckCondition} onChange={e => set('httpCheckCondition', e.target.value as DSHttpTaskParams['httpCheckCondition'])}>
            <option value="STATUS_CODE_DEFAULT">状态码默认(200)</option>
            <option value="STATUS_CODE_CUSTOM">状态码自定义</option>
            <option value="BODY_CONTAINS">Body包含</option>
            <option value="BODY_NOT_CONTAINS">Body不包含</option>
          </select>
        </div>
      </div>
      {params.httpCheckCondition !== 'STATUS_CODE_DEFAULT' && (
        <div className="tc-field">
          <label>校验内容</label>
          <input type="text" value={params.condition} onChange={e => set('condition', e.target.value)} placeholder="校验条件值" />
        </div>
      )}
      <div className="tc-field">
        <label>请求参数</label>
        <div className="tc-dynamic-list">
          {params.httpParams.map((p, i) => (
            <div key={i} className="tc-dynamic-list__item">
              <input type="text" value={p.prop} onChange={e => updateParam(i, 'prop', e.target.value)} placeholder="参数名" />
              <select value={p.httpParametersType} onChange={e => updateParam(i, 'httpParametersType', e.target.value)}>
                <option value="PARAMETER">Parameter</option>
                <option value="HEADERS">Headers</option>
                <option value="BODY">Body</option>
              </select>
              <input type="text" value={p.value} onChange={e => updateParam(i, 'value', e.target.value)} placeholder="参数值" />
              <button className="tc-dynamic-list__remove" onClick={() => removeParam(i)}><X size={12} /></button>
            </div>
          ))}
          <button className="tc-dynamic-list__add" onClick={addParam}><Plus size={12} /> 添加参数</button>
        </div>
      </div>
      {(params.httpMethod === 'POST' || params.httpMethod === 'PUT') && (
        <div className="tc-field">
          <label>请求体</label>
          <textarea className="tc-code" value={params.httpBody} onChange={e => set('httpBody', e.target.value)} placeholder='{"key": "value"}' rows={6} />
        </div>
      )}
      <div className="tc-row">
        <div className="tc-field">
          <label>连接超时(ms)</label>
          <input type="number" value={params.connectTimeout} onChange={e => set('connectTimeout', parseInt(e.target.value) || 60000)} min={0} />
        </div>
        <div className="tc-field">
          <label>Socket超时(ms)</label>
          <input type="number" value={params.socketTimeout} onChange={e => set('socketTimeout', parseInt(e.target.value) || 60000)} min={0} />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function SubProcessForm({ params, onChange, workflowDefinitions }: TaskFormProps<DSSubProcessTaskParams>) {
  const set = <K extends keyof DSSubProcessTaskParams>(key: K, val: DSSubProcessTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <div className="tc-field">
      <label>子工作流<span className="sm-required">*</span></label>
      <select value={params.workflowDefinitionCode} onChange={e => set('workflowDefinitionCode', Number(e.target.value))}>
        <option value={0}>请选择子工作流</option>
        {(workflowDefinitions || []).map(wf => (
          <option key={wf.code} value={wf.code}>{wf.name}</option>
        ))}
      </select>
      <div className="tc-help-text">选择要嵌套的子工作流定义</div>
    </div>
  );
}

export function DependentForm({ params, onChange, allNodes, currentCode, workflowDefinitions, api }: TaskFormProps<DSDependentTaskParams>) {
  const dependence = params.dependence ?? {
    relation: 'AND' as const,
    dependTaskList: [] as DSDependentTaskModel[],
    failurePolicy: 'DEPENDENT_FAILURE_FAILURE' as const,
    checkInterval: 10,
    failureWaitingTime: 0,
  };
  const [projects, setProjects] = useState<{ code: number; name: string }[]>([]);
  // 跨工作流上游任务码 -> 任务名，用于「任务名称」下拉回显真实上游名称
  const [taskNameMap, setTaskNameMap] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // 汇总所有依赖项涉及的工作流（项目 + 工作流定义），拉取其任务清单以解析任务名
    const pairs = new Map<number, number>();
    dependence.dependTaskList.forEach(g => {
      g.dependItemList.forEach(it => {
        if (it.definitionCode && it.projectCode) pairs.set(it.definitionCode, it.projectCode);
      });
    });
    const entries = Array.from(pairs.entries());
    if (entries.length === 0) return;
    Promise.all(
      entries.map(([defCode, projCode]) =>
        api.workflowDefinition.detail(projCode, defCode)
          .then(res => res?.data?.taskNodes ?? [])
          .catch(() => [] as DSWorkflowTaskNode[])
      )
    ).then((taskSets) => {
      if (cancelled) return;
      const map: Record<number, string> = {};
      taskSets.forEach(nodes => nodes.forEach(n => { if (n && n.code) map[n.code] = n.name; }));
      setTaskNameMap(map);
    });
    return () => { cancelled = true; };
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.project.list({ pageNo: 1, pageSize: 100 })
      .then((resp: unknown) => {
        if (cancelled) return;
        // 兼容两种返回结构：data 直接为数组，或为分页对象 { totalList: [...] }
        const raw = (resp as { data?: unknown })?.data;
        const list = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { totalList?: unknown })?.totalList)
            ? (raw as { totalList: { code: number; name: string }[] }).totalList
            : [];
        setProjects(list as { code: number; name: string }[]);
      })
      .catch(() => { /* 项目列表加载失败则仅显示项目编码 */ });
    return () => { cancelled = true; };
  }, [api]);
  const patch = (p: Partial<typeof dependence>) => onChange({ ...params, dependence: { ...dependence, ...p } });
  const otherNodes = allNodes.filter(n => n.code !== currentCode);
  const workflowList = workflowDefinitions && workflowDefinitions.length > 0 ? workflowDefinitions : null;
  const nodeCodeSet = new Set(otherNodes.map(n => n.code));
  const workflowCodeSet = new Set((workflowList ?? []).map(wf => wf.code));
  const projectCodeSet = new Set(projects.map(p => p.code));

  const addGroup = () => {
    const next = [...dependence.dependTaskList, { dependItemList: [], relation: 'AND' as const }];
    patch({ dependTaskList: next });
  };
  const removeGroup = (gi: number) => patch({ dependTaskList: dependence.dependTaskList.filter((_, i) => i !== gi) });
  const addItem = (gi: number) => {
    const next = [...dependence.dependTaskList];
    const model = next[gi];
    next[gi] = {
      ...model,
      dependItemList: [...model.dependItemList, {
        dependentType: 'DEPENDENT_ON_TASK' as const,
        projectCode: 0,
        definitionCode: workflowList ? workflowList[0].code : 0,
        depTaskCode: 0,
        cycle: 'day' as const,
        dateValue: 'today',
        parameterPassing: false,
      }],
    };
    patch({ dependTaskList: next });
  };
  const setGroupRelation = (gi: number, relation: 'AND' | 'OR') => {
    const next = [...dependence.dependTaskList];
    next[gi] = { ...next[gi], relation };
    patch({ dependTaskList: next });
  };
  const removeItem = (gi: number, ii: number) => {
    const next = [...dependence.dependTaskList];
    const model = next[gi];
    const dependItemList = model.dependItemList.filter((_, i) => i !== ii);
    if (dependItemList.length === 0) {
      next.splice(gi, 1);
    } else {
      next[gi] = { ...model, dependItemList };
    }
    patch({ dependTaskList: next });
  };
  const updateItem = (gi: number, ii: number, field: keyof DSDependentTaskItem, value: string | number | boolean) => {
    const next = [...dependence.dependTaskList];
    const model = next[gi];
    const dependItemList = [...model.dependItemList];
    dependItemList[ii] = { ...dependItemList[ii], [field]: value };
    next[gi] = { ...model, dependItemList };
    patch({ dependTaskList: next });
  };

  const cycleOptions: { value: DSDependentTaskItem['cycle']; label: string }[] = [
    { value: 'day', label: '天' },
    { value: 'hour', label: '小时' },
    { value: 'week', label: '周' },
    { value: 'month', label: '月' },
  ];
  const dateOptions: Record<string, { value: string; label: string }[]> = {
    day: [
      { value: 'today', label: '今天' },
      { value: 'last1Days', label: '前1天' },
      { value: 'last2Days', label: '前2天' },
      { value: 'last3Days', label: '前3天' },
      { value: 'last7Days', label: '前7天' },
    ],
    hour: [
      { value: 'currentHour', label: '当前小时' },
      { value: 'last1Hour', label: '前1小时' },
      { value: 'last2Hours', label: '前2小时' },
      { value: 'last3Hours', label: '前3小时' },
      { value: 'last24Hours', label: '前24小时' },
    ],
    week: [
      { value: 'thisWeek', label: '本周' },
      { value: 'lastWeek', label: '上周' },
      { value: 'thisWeekBegin', label: '本周周初' },
      { value: 'lastWeekBegin', label: '上周周初' },
      { value: 'lastWeekEnd', label: '上周周末' },
    ],
    month: [
      { value: 'thisMonth', label: '本月' },
      { value: 'lastMonth', label: '上月' },
      { value: 'thisMonthBegin', label: '本月初' },
      { value: 'lastMonthBegin', label: '上月初' },
      { value: 'lastMonthEnd', label: '上月末' },
    ],
  };

  return (
    <>
      <div className="tc-field">
        <label>依赖任务列表</label>
        <div className="tc-dynamic-list">
          {dependence.dependTaskList.map((group, gi) => (
            <div key={gi} className="tc-depend-group">
              <div className="tc-depend-group__head">
                <span className="tc-depend-group__title">依赖组 {gi + 1}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label className="tc-inline-select">
                    <span>组内关系</span>
                    <select
                      style={{ minWidth: 70 }}
                      value={group.relation}
                      onChange={e => setGroupRelation(gi, e.target.value as 'AND' | 'OR')}
                    >
                      <option value="AND">AND (且)</option>
                      <option value="OR">OR (或)</option>
                    </select>
                  </label>
                  <button className="tc-dynamic-list__remove" onClick={() => removeGroup(gi)} title="删除依赖组"><X size={12} /></button>
                </div>
              </div>
              {group.dependItemList.map((item, ii) => (
                <div key={ii} className="tc-depend-item">
                  <div className="tc-row">
                    <div className="tc-field">
                      <label>依赖类型</label>
                      <select
                        value={item.dependentType ?? 'DEPENDENT_ON_TASK'}
                        onChange={e => {
                          updateItem(gi, ii, 'dependentType', e.target.value);
                          // 切换依赖类型时重置目标任务
                          updateItem(gi, ii, 'depTaskCode', 0);
                        }}
                      >
                        <option value="DEPENDENT_ON_TASK">依赖于任务</option>
                        <option value="DEPENDENT_ON_WORKFLOW">依赖于工作流</option>
                      </select>
                    </div>
                    <div className="tc-field">
                      <label>项目名称<span className="sm-required">*</span></label>
                      <select
                        value={item.projectCode}
                        onChange={e => updateItem(gi, ii, 'projectCode', Number(e.target.value))}
                      >
                        {projects.length > 0 ? (
                          <>
                            <option value={0}>选择项目</option>
                            {projects.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}
                            {item.projectCode !== 0 && !projectCodeSet.has(item.projectCode) && (
                              <option value={item.projectCode}>项目 #{item.projectCode}</option>
                            )}
                          </>
                        ) : (
                          <option value={item.projectCode}>项目 #{item.projectCode}</option>
                        )}
                      </select>
                    </div>
                  </div>
                  <div className="tc-row">
                    <div className="tc-field">
                      <label>工作流名称<span className="sm-required">*</span></label>
                      <select
                        value={item.definitionCode}
                        onChange={e => updateItem(gi, ii, 'definitionCode', Number(e.target.value))}
                      >
                        {workflowList && item.definitionCode !== 0 && !workflowCodeSet.has(item.definitionCode) && (
                          <option value={item.definitionCode}>工作流 #{item.definitionCode}</option>
                        )}
                        {workflowList ? (
                          workflowList.map(wf => <option key={wf.code} value={wf.code}>{wf.name}</option>)
                        ) : (
                          <option value={0}>当前工作流</option>
                        )}
                      </select>
                    </div>
                    <div className="tc-field">
                      <label>任务名称<span className="sm-required">*</span></label>
                      <select
                        value={item.depTaskCode}
                        onChange={e => updateItem(gi, ii, 'depTaskCode', Number(e.target.value))}
                      >
                        <option value={0}>选择任务</option>
                        {otherNodes.map(n => <option key={n.code} value={n.code}>{n.name}</option>)}
                        {item.depTaskCode !== 0 && !nodeCodeSet.has(item.depTaskCode) && (
                          <option value={item.depTaskCode}>
                            {taskNameMap[item.depTaskCode] ? taskNameMap[item.depTaskCode] : `任务 #${item.depTaskCode}（未在当前工作流）`}
                          </option>
                        )}
                      </select>
                    </div>
                  </div>
                  <div className="tc-field">
                    <label>时间周期<span className="sm-required">*</span></label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <select
                        style={{ flex: 1 }}
                        value={item.cycle}
                        onChange={e => {
                          const cycle = e.target.value as DSDependentTaskItem['cycle'];
                          updateItem(gi, ii, 'cycle', cycle);
                          updateItem(gi, ii, 'dateValue', dateOptions[cycle][0].value);
                        }}
                      >
                        {cycleOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                      <select
                        style={{ flex: 1.4 }}
                        value={item.dateValue}
                        onChange={e => updateItem(gi, ii, 'dateValue', e.target.value)}
                      >
                        {(dateOptions[item.cycle] || dateOptions.day).map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="tc-depend-item__foot">
                    <label className="tc-switch">
                      <input
                        type="checkbox"
                        checked={!!item.parameterPassing}
                        onChange={e => updateItem(gi, ii, 'parameterPassing', e.target.checked)}
                      />
                      <span>参数传递</span>
                    </label>
                    <button className="tc-dynamic-list__remove" onClick={() => removeItem(gi, ii)} title="删除依赖"><X size={12} /></button>
                  </div>
                </div>
              ))}
              <button className="tc-dynamic-list__add" onClick={() => addItem(gi)}><Plus size={12} /> 添加依赖项</button>
            </div>
          ))}
          <button className="tc-dynamic-list__add" onClick={addGroup}><Plus size={12} /> 添加依赖组</button>
        </div>
      </div>
      <div className="tc-field">
        <label>失败策略</label>
        <select value={dependence.failurePolicy} onChange={e => patch({ failurePolicy: e.target.value as 'DEPENDENT_FAILURE_FAILURE' | 'DEPENDENT_FAILURE_WAITING' })}>
          <option value="DEPENDENT_FAILURE_FAILURE">依赖失败则失败</option>
          <option value="DEPENDENT_FAILURE_WAITING">依赖失败则等待</option>
        </select>
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>检查间隔(秒)</label>
          <input type="number" value={dependence.checkInterval} onChange={e => patch({ checkInterval: parseInt(e.target.value) || 10 })} min={1} />
        </div>
        {dependence.failurePolicy === 'DEPENDENT_FAILURE_WAITING' && (
          <div className="tc-field">
            <label>等待时间(分钟)</label>
            <input type="number" value={dependence.failureWaitingTime} onChange={e => patch({ failureWaitingTime: parseInt(e.target.value) || 0 })} min={0} />
          </div>
        )}
      </div>
    </>
  );
}

export function ConditionsForm({ params, onChange, allNodes, currentCode }: TaskFormProps<DSConditionsTaskParams>) {
  const set = <K extends keyof DSConditionsTaskParams>(key: K, val: DSConditionsTaskParams[K]) =>
    onChange({ ...params, [key]: val });
  const otherNodes = allNodes.filter(n => n.code !== currentCode);

  const addDep = () => set('dependTaskList', [...params.dependTaskList, { depTaskCode: 0, status: 'SUCCESS' as const }]);
  const removeDep = (i: number) => set('dependTaskList', params.dependTaskList.filter((_, idx) => idx !== i));
  const updateDep = (i: number, field: string, value: number | string) => {
    const next = [...params.dependTaskList];
    next[i] = { ...next[i], [field]: value };
    set('dependTaskList', next);
  };

  return (
    <>
      <div className="tc-field">
        <label>前置任务检查条件</label>
        <div className="tc-dynamic-list">
          {params.dependTaskList.map((dep, i) => (
            <div key={i} className="tc-dynamic-list__item">
              <select value={dep.depTaskCode} onChange={e => updateDep(i, 'depTaskCode', Number(e.target.value))}>
                <option value={0}>选择前置任务</option>
                {otherNodes.map(n => <option key={n.code} value={n.code}>{n.name}</option>)}
              </select>
              <select value={dep.status} onChange={e => updateDep(i, 'status', e.target.value)}>
                <option value="SUCCESS">成功</option>
                <option value="FAILURE">失败</option>
              </select>
              <button className="tc-dynamic-list__remove" onClick={() => removeDep(i)}><X size={12} /></button>
            </div>
          ))}
          <button className="tc-dynamic-list__add" onClick={addDep}><Plus size={12} /> 添加前置条件</button>
        </div>
      </div>
      <div className="tc-field">
        <label>条件关系</label>
        <div className="tc-radio-group">
          <label className="tc-radio">
            <input type="radio" name="condRelation" checked={params.relation === 'AND'} onChange={() => set('relation', 'AND')} />
            <span>AND</span>
          </label>
          <label className="tc-radio">
            <input type="radio" name="condRelation" checked={params.relation === 'OR'} onChange={() => set('relation', 'OR')} />
            <span>OR</span>
          </label>
        </div>
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>成功分支流向</label>
          <select value={params.successBranch ?? 0} onChange={e => set('successBranch', Number(e.target.value) || null)}>
            <option value={0}>无</option>
            {otherNodes.map(n => <option key={n.code} value={n.code}>{n.name}</option>)}
          </select>
        </div>
        <div className="tc-field">
          <label>失败分支流向</label>
          <select value={params.failedBranch ?? 0} onChange={e => set('failedBranch', Number(e.target.value) || null)}>
            <option value={0}>无</option>
            {otherNodes.map(n => <option key={n.code} value={n.code}>{n.name}</option>)}
          </select>
        </div>
      </div>
    </>
  );
}

export function SwitchForm({ params, onChange, allNodes, currentCode }: TaskFormProps<DSSwitchTaskParams>) {
  const set = (val: Partial<DSSwitchTaskParams>) =>
    onChange({ ...params, ...val });
  const otherNodes = allNodes.filter(n => n.code !== currentCode);
  const list = params.switchResult.dependTaskList;

  const addBranch = () => set({ switchResult: { ...params.switchResult, dependTaskList: [...list, { condition: '', nextNode: null }] } });
  const removeBranch = (i: number) => set({ switchResult: { ...params.switchResult, dependTaskList: list.filter((_, idx) => idx !== i) } });
  const updateBranch = (i: number, field: string, value: string | number | null) => {
    const next = [...list];
    next[i] = { ...next[i], [field]: value };
    set({ switchResult: { ...params.switchResult, dependTaskList: next } });
  };

  return (
    <>
      <div className="tc-field">
        <label>条件分支</label>
        <div className="tc-dynamic-list">
          {list.map((branch, i) => (
            <div key={i} className="tc-dynamic-list__item">
              <span className="tc-label-pair"><span>条件{i + 1}:</span></span>
              <input type="text" value={branch.condition} onChange={e => updateBranch(i, 'condition', e.target.value)} placeholder="条件表达式" style={{ flex: 2 }} />
              <select value={branch.nextNode ?? 0} onChange={e => updateBranch(i, 'nextNode', Number(e.target.value) || null)}>
                <option value={0}>选择分支任务</option>
                {otherNodes.map(n => <option key={n.code} value={n.code}>{n.name}</option>)}
              </select>
              <button className="tc-dynamic-list__remove" onClick={() => removeBranch(i)}><X size={12} /></button>
            </div>
          ))}
          <button className="tc-dynamic-list__add" onClick={addBranch}><Plus size={12} /> 添加条件分支</button>
        </div>
      </div>
      <div className="tc-field">
        <label>默认分支</label>
        <select value={params.switchResult.nextNode ?? 0} onChange={e => set({ switchResult: { ...params.switchResult, nextNode: Number(e.target.value) || null } })}>
          <option value={0}>无默认分支</option>
          {otherNodes.map(n => <option key={n.code} value={n.code}>{n.name}</option>)}
        </select>
        <div className="tc-help-text">所有条件都不满足时执行的分支</div>
      </div>
    </>
  );
}

export function SeaTunnelForm({ params, onChange }: TaskFormProps<DSSeaTunnelTaskParams>) {
  const set = <K extends keyof DSSeaTunnelTaskParams>(key: K, val: DSSeaTunnelTaskParams[K]) =>
    onChange({ ...params, [key]: val });
  const isFlink = params.startupScript.includes('flink');
  const isSpark = params.startupScript.includes('spark');

  return (
    <>
      <div className="tc-field">
        <label>启动脚本</label>
        <select value={params.startupScript} onChange={e => set('startupScript', e.target.value)}>
          <option value="seatunnel.sh">seatunnel.sh (Spark)</option>
          <option value="seatunnel-flink.sh">seatunnel-flink.sh (Flink 1.13+)</option>
          <option value="seatunnel-flink-213.sh">seatunnel-flink-213.sh (Flink 1.13+ Scala 2.13)</option>
          <option value="seatunnel-spark.sh">seatunnel-spark.sh (Spark 2.x)</option>
          <option value="seatunnel-spark-3.sh">seatunnel-spark-3.sh (Spark 3.x)</option>
        </select>
      </div>
      {isFlink && (
        <div className="tc-field">
          <label>运行模式</label>
          <select value={params.runMode} onChange={e => set('runMode', e.target.value as DSSeaTunnelTaskParams['runMode'])}>
            <option value="NONE">NONE</option>
            <option value="RUN">RUN</option>
            <option value="RUN_APPLICATION">RUN_APPLICATION</option>
          </select>
        </div>
      )}
      {isSpark && (
        <>
          <div className="tc-row">
            <div className="tc-field">
              <label>部署模式</label>
              <select value={params.deployMode} onChange={e => set('deployMode', e.target.value)}>
                <option value="client">client</option>
                <option value="cluster">cluster</option>
                <option value="local">local</option>
              </select>
            </div>
            <div className="tc-field">
              <label>Master</label>
              <select value={params.master} onChange={e => set('master', e.target.value)}>
                <option value="YARN">YARN</option>
                <option value="LOCAL">LOCAL</option>
                <option value="SPARK">SPARK</option>
                <option value="MESOS">MESOS</option>
              </select>
            </div>
          </div>
          {(params.master === 'SPARK' || params.master === 'MESOS') && (
            <div className="tc-field">
              <label>Master URL</label>
              <input type="text" value={params.masterUrl} onChange={e => set('masterUrl', e.target.value)} placeholder="spark://host:7077" />
            </div>
          )}
        </>
      )}
      <div className="tc-field">
        <label className="tc-switch">
          <input type="checkbox" checked={params.useCustom} onChange={e => set('useCustom', e.target.checked)} />
          <span>使用自定义配置</span>
        </label>
      </div>
      {params.useCustom ? (
        <div className="tc-field">
          <label>SeaTunnel配置(HOCON)<span className="sm-required">*</span></label>
          <textarea
            className="tc-code"
            value={params.rawScript}
            onChange={e => set('rawScript', e.target.value)}
            placeholder={'env { execution.parallelism = 1 }\nsource { } \ntransform { }\nsink { }'}
            rows={12}
          />
        </div>
      ) : (
        <div className="tc-field">
          <label>配置文件</label>
          <input type="text" value={params.resourceList[0] || ''} onChange={e => set('resourceList', e.target.value ? [e.target.value] : [])} placeholder="hdfs:///path/to/config.conf" />
        </div>
      )}
    </>
  );
}

export function K8sForm({ params, onChange }: TaskFormProps<DSK8sTaskParams>) {
  const set = <K extends keyof DSK8sTaskParams>(key: K, val: DSK8sTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  const addLabel = () => set('customizedLabels', [...params.customizedLabels, { key: '', value: '' }]);
  const removeLabel = (i: number) => set('customizedLabels', params.customizedLabels.filter((_, idx) => idx !== i));
  const updateLabel = (i: number, field: 'key' | 'value', val: string) => {
    const next = [...params.customizedLabels];
    next[i] = { ...next[i], [field]: val };
    set('customizedLabels', next);
  };

  return (
    <>
      <div className="tc-field">
        <label>命名空间<span className="sm-required">*</span></label>
        <input type="text" value={params.namespace} onChange={e => set('namespace', e.target.value)} placeholder="default" />
      </div>
      <div className="tc-field">
        <label>镜像地址<span className="sm-required">*</span></label>
        <input type="text" value={params.image} onChange={e => set('image', e.target.value)} placeholder="nginx:latest" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>镜像拉取策略</label>
          <select value={params.imagePullPolicy} onChange={e => set('imagePullPolicy', e.target.value as DSK8sTaskParams['imagePullPolicy'])}>
            <option value="IfNotPresent">IfNotPresent</option>
            <option value="Always">Always</option>
            <option value="Never">Never</option>
          </select>
        </div>
        <div className="tc-field">
          <label>拉取密钥</label>
          <input type="text" value={params.pullSecret} onChange={e => set('pullSecret', e.target.value)} placeholder="registry-secret" />
        </div>
      </div>
      <div className="tc-field">
        <label>执行命令</label>
        <textarea value={params.command} onChange={e => set('command', e.target.value)} placeholder="/bin/sh -c" rows={2} />
      </div>
      <div className="tc-field">
        <label>命令参数</label>
        <textarea value={params.args} onChange={e => set('args', e.target.value)} placeholder="echo 'Hello K8S'" rows={2} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>最小CPU(核)</label>
          <input type="number" value={params.minCpuCores || ''} onChange={e => set('minCpuCores', parseFloat(e.target.value) || 0)} min={0} step={0.1} />
        </div>
        <div className="tc-field">
          <label>最小内存</label>
          <input type="text" value={params.minMemorySpace} onChange={e => set('minMemorySpace', e.target.value)} placeholder="100Mi / 1Gi" />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义标签</label>
        <div className="tc-dynamic-list">
          {params.customizedLabels.map((lbl, i) => (
            <div key={i} className="tc-dynamic-list__item">
              <input type="text" value={lbl.key} onChange={e => updateLabel(i, 'key', e.target.value)} placeholder="标签键" />
              <input type="text" value={lbl.value} onChange={e => updateLabel(i, 'value', e.target.value)} placeholder="标签值" />
              <button className="tc-dynamic-list__remove" onClick={() => removeLabel(i)}><X size={12} /></button>
            </div>
          ))}
          <button className="tc-dynamic-list__add" onClick={addLabel}><Plus size={12} /> 添加标签</button>
        </div>
      </div>
    </>
  );
}

export function JavaForm({ params, onChange, api }: TaskFormProps<DSJavaTaskParams>) {
  const set = <K extends keyof DSJavaTaskParams>(key: K, val: DSJavaTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>运行类型</label>
          <select value={params.runType} onChange={e => set('runType', e.target.value as DSJavaTaskParams['runType'])}>
            <option value="FAT_JAR">FAT_JAR</option>
            <option value="NORMAL_JAR">NORMAL_JAR</option>
          </select>
        </div>
        <div className="tc-field">
          <label className="tc-switch" style={{ marginTop: 20 }}>
            <input type="checkbox" checked={params.isModulePath} onChange={e => set('isModulePath', e.target.checked)} />
            <span>模块路径</span>
          </label>
        </div>
      </div>
      <div className="tc-field">
        <label>主Class</label>
        <input type="text" value={params.mainClass} onChange={e => set('mainClass', e.target.value)} placeholder="com.example.MainClass" />
      </div>
      {api ? (
        <ResourceSelect
          value={params.mainJar}
          onChange={(val) => set('mainJar', val)}
          api={api}
          label="主程序包"
          placeholder="请选择主程序包"
        />
      ) : (
        <div className="tc-field">
          <label>主程序包</label>
          <input type="text" value={params.mainJar} onChange={e => set('mainJar', e.target.value)} placeholder="hdfs:///path/to/jar" />
        </div>
      )}
      <div className="tc-field">
        <label>主参数</label>
        <textarea value={params.mainArgs} onChange={e => set('mainArgs', e.target.value)} placeholder="程序运行参数" rows={3} />
      </div>
      <div className="tc-field">
        <label>JVM参数</label>
        <textarea value={params.jvmArgs} onChange={e => set('jvmArgs', e.target.value)} placeholder="-Xmx1g -Xms512m" rows={2} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function FlinkStreamForm({ params, onChange }: TaskFormProps<DSFlinkStreamTaskParams>) {
  const set = <K extends keyof DSFlinkStreamTaskParams>(key: K, val: DSFlinkStreamTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>程序类型</label>
          <select value={params.programType} onChange={e => set('programType', e.target.value as DSFlinkStreamTaskParams['programType'])}>
            <option value="JAVA">JAVA</option>
            <option value="SCALA">SCALA</option>
            <option value="PYTHON">PYTHON</option>
          </select>
        </div>
        <div className="tc-field">
          <label>Flink版本</label>
          <select value={params.flinkVersion} onChange={e => set('flinkVersion', e.target.value)}>
            <option value="&lt;1.10">&lt;1.10</option>
            <option value="1.10-1.12">1.10-1.12</option>
            <option value="&gt;=1.12">&gt;=1.12</option>
          </select>
        </div>
      </div>
      <div className="tc-field">
        <label>部署模式</label>
        <select value={params.deployMode} onChange={e => set('deployMode', e.target.value)}>
          <option value="cluster">cluster</option>
          <option value="local">local</option>
          <option value="standalone">standalone</option>
        </select>
      </div>
      <div className="tc-field">
        <label>SQL脚本</label>
        <textarea className="tc-code" value={params.rawScript} onChange={e => set('rawScript', e.target.value)} placeholder="INSERT INTO target SELECT * FROM source" rows={8} />
      </div>
      <div className="tc-field">
        <label>初始化脚本</label>
        <textarea className="tc-code" value={params.initScript} onChange={e => set('initScript', e.target.value)} placeholder="SET table.sql-dialect=default;" rows={4} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>JobManager内存</label>
          <input type="text" value={params.jobManagerMemory} onChange={e => set('jobManagerMemory', e.target.value)} placeholder="1G" />
        </div>
        <div className="tc-field">
          <label>TaskManager内存</label>
          <input type="text" value={params.taskManagerMemory} onChange={e => set('taskManagerMemory', e.target.value)} placeholder="2G" />
        </div>
      </div>
      <div className="tc-row tc-row--3">
        <div className="tc-field">
          <label>Slot数</label>
          <input type="number" value={params.slot} onChange={e => set('slot', parseInt(e.target.value) || 1)} min={1} />
        </div>
        <div className="tc-field">
          <label>TaskManager数</label>
          <input type="number" value={params.taskManager} onChange={e => set('taskManager', parseInt(e.target.value) || 2)} min={1} />
        </div>
        <div className="tc-field">
          <label>并行度</label>
          <input type="number" value={params.parallelism} onChange={e => set('parallelism', parseInt(e.target.value) || 1)} min={1} />
        </div>
      </div>
      <div className="tc-field">
        <label>YARN队列</label>
        <input type="text" value={params.yarnQueue} onChange={e => set('yarnQueue', e.target.value)} placeholder="default" />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function SqoopForm({ params, onChange }: TaskFormProps<DSSqoopTaskParams>) {
  const set = <K extends keyof DSSqoopTaskParams>(key: K, val: DSSqoopTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label className="tc-switch">
          <input type="checkbox" checked={params.isCustomTask} onChange={e => set('isCustomTask', e.target.checked)} />
          <span>自定义任务</span>
        </label>
      </div>
      {params.isCustomTask ? (
        <div className="tc-field">
          <label>自定义Shell脚本</label>
          <textarea className="tc-code" value={params.localParams?.[0]?.value || ''} onChange={e => {
            const lp = [{ prop: 'shell', direct: 'IN' as const, type: 'VARCHAR' as const, value: e.target.value }];
            set('localParams', lp);
          }} placeholder="sqoop import --connect jdbc:mysql://..." rows={8} />
        </div>
      ) : (
        <>
          <div className="tc-row">
            <div className="tc-field">
              <label>方向</label>
              <select value={params.modelType} onChange={e => set('modelType', e.target.value as 'import' | 'export')}>
                <option value="import">导入(import)</option>
                <option value="export">导出(export)</option>
              </select>
            </div>
            <div className="tc-field">
              <label>并发数</label>
              <input type="number" value={params.concurrency} onChange={e => set('concurrency', parseInt(e.target.value) || 1)} min={1} />
            </div>
          </div>
          <div className="tc-row">
            <div className="tc-field">
              <label>源数据源类型</label>
              <select value={params.sourceType} onChange={e => set('sourceType', e.target.value)}>
                <option value="MYSQL">MYSQL</option>
                <option value="HIVE">HIVE</option>
                <option value="HDFS">HDFS</option>
                <option value="POSTGRESQL">POSTGRESQL</option>
                <option value="ORACLE">ORACLE</option>
              </select>
            </div>
            <div className="tc-field">
              <label>目标类型</label>
              <select value={params.targetType} onChange={e => set('targetType', e.target.value)}>
                <option value="HIVE">HIVE</option>
                <option value="HDFS">HDFS</option>
                <option value="MYSQL">MYSQL</option>
                <option value="POSTGRESQL">POSTGRESQL</option>
                <option value="ORACLE">ORACLE</option>
              </select>
            </div>
          </div>
          <div className="tc-field">
            <label>SplitBy字段</label>
            <input type="text" value={params.splitBy} onChange={e => set('splitBy', e.target.value)} placeholder="id" />
          </div>
          {params.targetType === 'HDFS' && (
            <div className="tc-row">
              <div className="tc-field">
                <label className="tc-switch">
                  <input type="checkbox" checked={params.targetHdfsDeleteTargetDir} onChange={e => set('targetHdfsDeleteTargetDir', e.target.checked)} />
                  <span>删除目标目录</span>
                </label>
              </div>
              <div className="tc-field">
                <label>压缩编码</label>
                <select value={params.targetHdfsCompressionCodec} onChange={e => set('targetHdfsCompressionCodec', e.target.value)}>
                  <option value="snappy">snappy</option>
                  <option value="gzip">gzip</option>
                  <option value="lz4">lz4</option>
                  <option value="none">不压缩</option>
                </select>
              </div>
            </div>
          )}
          {params.targetType === 'HIVE' && (
            <div className="tc-row">
              <div className="tc-field">
                <label className="tc-switch">
                  <input type="checkbox" checked={params.targetHiveCreateTable} onChange={e => set('targetHiveCreateTable', e.target.checked)} />
                  <span>自动建表</span>
                </label>
              </div>
              <div className="tc-field">
                <label className="tc-switch">
                  <input type="checkbox" checked={params.targetHiveOverWrite} onChange={e => set('targetHiveOverWrite', e.target.checked)} />
                  <span>覆盖写入</span>
                </label>
              </div>
            </div>
          )}
        </>
      )}
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function GrpcForm({ params, onChange }: TaskFormProps<DSGrpcTaskParams>) {
  const set = <K extends keyof DSGrpcTaskParams>(key: K, val: DSGrpcTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>请求地址<span className="sm-required">*</span></label>
        <input type="text" value={params.url} onChange={e => set('url', e.target.value)} placeholder="localhost:50051" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>凭证类型</label>
          <select value={params.grpcCredentialType} onChange={e => set('grpcCredentialType', e.target.value as DSGrpcTaskParams['grpcCredentialType'])}>
            <option value="INSECURE">INSECURE</option>
            <option value="TLS">TLS</option>
            <option value="TOKEN">TOKEN</option>
          </select>
        </div>
        <div className="tc-field">
          <label>校验条件</label>
          <select value={params.grpcCheckCondition} onChange={e => set('grpcCheckCondition', e.target.value as DSGrpcTaskParams['grpcCheckCondition'])}>
            <option value="STATUS_CODE_DEFAULT">状态码默认</option>
            <option value="STATUS_CODE_CUSTOM">状态码自定义</option>
            <option value="BODY_CONTAINS">Body包含</option>
            <option value="BODY_NOT_CONTAINS">Body不包含</option>
          </select>
        </div>
      </div>
      {params.grpcCheckCondition !== 'STATUS_CODE_DEFAULT' && (
        <div className="tc-field">
          <label>校验内容</label>
          <input type="text" value={params.condition} onChange={e => set('condition', e.target.value)} placeholder="校验条件值" />
        </div>
      )}
      <div className="tc-field">
        <label>服务定义JSON</label>
        <textarea className="tc-code" value={params.grpcServiceDefinitionJSON} onChange={e => set('grpcServiceDefinitionJSON', e.target.value)} placeholder='{"service": "MyService", "method": "MyMethod"}' rows={6} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>连接超时(ms)</label>
          <input type="number" value={params.grpcConnectTimeoutMs} onChange={e => set('grpcConnectTimeoutMs', parseInt(e.target.value) || 60000)} min={0} />
        </div>
        <div className="tc-field">
          <label>Socket超时(ms)</label>
          <input type="number" value={params.socketTimeout} onChange={e => set('socketTimeout', parseInt(e.target.value) || 60000)} min={0} />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function EmrForm({ params, onChange }: TaskFormProps<DSEmrTaskParams>) {
  const set = <K extends keyof DSEmrTaskParams>(key: K, val: DSEmrTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>程序类型</label>
        <select value={params.programType} onChange={e => set('programType', e.target.value as DSEmrTaskParams['programType'])}>
          <option value="ADD_JOB_FLOW_STEPS">ADD_JOB_FLOW_STEPS</option>
          <option value="RUN_JOB_FLOW">RUN_JOB_FLOW</option>
          <option value="TERMINATE_JOB_FLOW">TERMINATE_JOB_FLOW</option>
          <option value="TERMINATE_CLUSTER">TERMINATE_CLUSTER</option>
        </select>
      </div>
      <div className="tc-field">
        <label>JobFlow定义JSON</label>
        <textarea className="tc-code" value={params.jobFlowDefinitionJSON} onChange={e => set('jobFlowDefinitionJSON', e.target.value)} placeholder='{"Steps": [{"Jar": "command-runner.jar", "Args": ["spark-submit", ...]}]}' rows={8} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function ZeppelinForm({ params, onChange }: TaskFormProps<DSZeppelinTaskParams>) {
  const set = <K extends keyof DSZeppelinTaskParams>(key: K, val: DSZeppelinTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>RestEndpoint<span className="sm-required">*</span></label>
        <input type="text" value={params.restEndpoint} onChange={e => set('restEndpoint', e.target.value)} placeholder="http://localhost:8080" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>用户名</label>
          <input type="text" value={params.username} onChange={e => set('username', e.target.value)} placeholder="admin" />
        </div>
        <div className="tc-field">
          <label>密码</label>
          <input type="password" value={params.password} onChange={e => set('password', e.target.value)} placeholder="密码" />
        </div>
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>Note ID<span className="sm-required">*</span></label>
          <input type="text" value={params.noteId} onChange={e => set('noteId', e.target.value)} placeholder="2A94M5J1Z" />
        </div>
        <div className="tc-field">
          <label>Paragraph ID</label>
          <input type="text" value={params.paragraphId} onChange={e => set('paragraphId', e.target.value)} placeholder="留空执行整个Note" />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function JupyterForm({ params, onChange }: TaskFormProps<DSJupyterTaskParams>) {
  const set = <K extends keyof DSJupyterTaskParams>(key: K, val: DSJupyterTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>脚本<span className="sm-required">*</span></label>
        <textarea className="tc-code" value={params.rawScript} onChange={e => set('rawScript', e.target.value)} placeholder="print('Hello Jupyter')" rows={8} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>CPU配额</label>
          <input type="number" value={params.cpuQuota} onChange={e => set('cpuQuota', parseInt(e.target.value) || -1)} min={-1} />
          <div className="tc-help-text">-1 表示不限制</div>
        </div>
        <div className="tc-field">
          <label>最大内存(MB)</label>
          <input type="number" value={params.memoryMax} onChange={e => set('memoryMax', parseInt(e.target.value) || -1)} min={-1} />
          <div className="tc-help-text">-1 表示不限制</div>
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function MlflowForm({ params, onChange }: TaskFormProps<DSMlflowTaskParams>) {
  const set = <K extends keyof DSMlflowTaskParams>(key: K, val: DSMlflowTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>MLflow任务类型</label>
          <select value={params.mlflowTaskType} onChange={e => set('mlflowTaskType', e.target.value as DSMlflowTaskParams['mlflowTaskType'])}>
            <option value="MLflow Projects">MLflow Projects</option>
            <option value="MLflow Models">MLflow Models</option>
            <option value="MLflow AutoML">MLflow AutoML</option>
          </select>
        </div>
        <div className="tc-field">
          <label>Tracking URI</label>
          <input type="text" value={params.mlflowTrackingUri} onChange={e => set('mlflowTrackingUri', e.target.value)} placeholder="http://127.0.0.1:5000" />
        </div>
      </div>
      {params.mlflowTaskType === 'MLflow Projects' && (
        <>
          <div className="tc-row">
            <div className="tc-field">
              <label>Job类型</label>
              <select value={params.mlflowJobType} onChange={e => set('mlflowJobType', e.target.value as DSMlflowTaskParams['mlflowJobType'])}>
                <option value="CustomProject">自定义项目</option>
                <option value="GitHubProject">GitHub项目</option>
              </select>
            </div>
            <div className="tc-field">
              <label>算法</label>
              <input type="text" value={params.algorithm} onChange={e => set('algorithm', e.target.value)} placeholder="svm" />
            </div>
          </div>
          <div className="tc-field">
            <label>自定义项目参数</label>
            <LocalParamsEditor params={params.mlflowCustomProjectParameters} onChange={p => set('mlflowCustomProjectParameters', p)} />
          </div>
        </>
      )}
      {params.mlflowTaskType === 'MLflow Models' && (
        <div className="tc-row">
          <div className="tc-field">
            <label>部署类型</label>
            <select value={params.deployType} onChange={e => set('deployType', e.target.value as DSMlflowTaskParams['deployType'])}>
              <option value="MLFLOW">MLFLOW</option>
              <option value="DOCKER">DOCKER</option>
            </select>
          </div>
          <div className="tc-field">
            <label>部署端口</label>
            <input type="text" value={params.deployPort} onChange={e => set('deployPort', e.target.value)} placeholder="7000" />
          </div>
        </div>
      )}
      {params.mlflowTaskType === 'MLflow AutoML' && (
        <div className="tc-field">
          <label>AutoML工具</label>
          <select value={params.automlTool} onChange={e => set('automlTool', e.target.value as DSMlflowTaskParams['automlTool'])}>
            <option value="flaml">FLAML</option>
          </select>
        </div>
      )}
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function OpenmldbForm({ params, onChange }: TaskFormProps<DSOpenmldbTaskParams>) {
  const set = <K extends keyof DSOpenmldbTaskParams>(key: K, val: DSOpenmldbTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>ZooKeeper地址<span className="sm-required">*</span></label>
          <input type="text" value={params.zk} onChange={e => set('zk', e.target.value)} placeholder="localhost:2181" />
        </div>
        <div className="tc-field">
          <label>ZK路径</label>
          <input type="text" value={params.zkPath} onChange={e => set('zkPath', e.target.value)} placeholder="/openmldb" />
        </div>
      </div>
      <div className="tc-field">
        <label>执行模式</label>
        <select value={params.executeMode} onChange={e => set('executeMode', e.target.value as DSOpenmldbTaskParams['executeMode'])}>
          <option value="offline">离线</option>
          <option value="online">在线</option>
        </select>
      </div>
      <div className="tc-field">
        <label>SQL语句<span className="sm-required">*</span></label>
        <textarea className="tc-code" value={params.sql} onChange={e => set('sql', e.target.value)} placeholder="SELECT * FROM table_name" rows={6} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function DvcForm({ params, onChange }: TaskFormProps<DSDvcTaskParams>) {
  const set = <K extends keyof DSDvcTaskParams>(key: K, val: DSDvcTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>DVC任务类型</label>
        <select value={params.dvcTaskType} onChange={e => set('dvcTaskType', e.target.value as DSDvcTaskParams['dvcTaskType'])}>
          <option value="Upload">上传</option>
          <option value="Download">下载</option>
        </select>
      </div>
      <div className="tc-field">
        <label>DVC仓库</label>
        <input type="text" value={params.dvcRepository} onChange={e => set('dvcRepository', e.target.value)} placeholder="https://github.com/user/repo" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>版本</label>
          <input type="text" value={params.dvcVersion} onChange={e => set('dvcVersion', e.target.value)} placeholder="v1.0" />
        </div>
        <div className="tc-field">
          <label>数据路径</label>
          <input type="text" value={params.dvcDataPath} onChange={e => set('dvcDataPath', e.target.value)} placeholder="data/dataset" />
        </div>
      </div>
      <div className="tc-field">
        <label>存储URL</label>
        <input type="text" value={params.dvcStoreUrl} onChange={e => set('dvcStoreUrl', e.target.value)} placeholder="s3://bucket/path" />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function DinkyForm({ params, onChange }: TaskFormProps<DSDinkyTaskParams>) {
  const set = <K extends keyof DSDinkyTaskParams>(key: K, val: DSDinkyTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>Dinky地址</label>
        <input type="text" value={params.dinkyUrl} onChange={e => set('dinkyUrl', e.target.value)} placeholder="http://localhost:8888" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>Dinky任务ID<span className="sm-required">*</span></label>
          <input type="number" value={params.dinkyTaskId} onChange={e => set('dinkyTaskId', parseInt(e.target.value) || 0)} min={0} />
        </div>
        <div className="tc-field">
          <label>任务类型</label>
          <input type="text" value={params.dinkyTaskType} onChange={e => set('dinkyTaskType', e.target.value)} placeholder="FlinkSQL" />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function SagemakerForm({ params, onChange }: TaskFormProps<DSSagemakerTaskParams>) {
  const set = <K extends keyof DSSagemakerTaskParams>(key: K, val: DSSagemakerTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>AWS区域</label>
          <input type="text" value={params.awsRegion} onChange={e => set('awsRegion', e.target.value)} placeholder="us-east-1" />
        </div>
        <div className="tc-field">
          <label>Job类型</label>
          <select value={params.sagemakerJobType} onChange={e => set('sagemakerJobType', e.target.value as DSSagemakerTaskParams['sagemakerJobType'])}>
            <option value="TrainingJob">TrainingJob</option>
            <option value="TransformJob">TransformJob</option>
            <option value="Endpoint">Endpoint</option>
          </select>
        </div>
      </div>
      <div className="tc-field">
        <label>Job配置JSON</label>
        <textarea className="tc-code" value={params.sagemakerJobConfigJSON} onChange={e => set('sagemakerJobConfigJSON', e.target.value)} placeholder='{"AlgorithmSpecification": {"TrainingImage": "...", "TrainingInputMode": "File"}}' rows={8} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function ChunjunForm({ params, onChange }: TaskFormProps<DSChunjunTaskParams>) {
  const set = <K extends keyof DSChunjunTaskParams>(key: K, val: DSChunjunTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-row">
        <div className="tc-field">
          <label>部署模式</label>
          <select value={params.deployMode} onChange={e => set('deployMode', e.target.value as DSChunjunTaskParams['deployMode'])}>
            <option value="local">local</option>
            <option value="standalone">standalone</option>
            <option value="yarn-session">yarn-session</option>
            <option value="yarn-per-job">yarn-per-job</option>
          </select>
        </div>
        <div className="tc-field">
          <label className="tc-switch" style={{ marginTop: 20 }}>
            <input type="checkbox" checked={params.customConfig} onChange={e => set('customConfig', e.target.checked)} />
            <span>自定义JSON</span>
          </label>
        </div>
      </div>
      {params.customConfig ? (
        <div className="tc-field">
          <label>JSON配置<span className="sm-required">*</span></label>
          <textarea className="tc-code" value={params.json} onChange={e => set('json', e.target.value)} placeholder='{"job":{"content":[{"reader":{}, "writer":{}}]}}' rows={12} />
        </div>
      ) : (
        <>
          <div className="tc-field">
            <label>源数据源</label>
            <DatasourceSelect value={params.datasource} typeValue={params.dsType} onChange={v => set('datasource', v)} onTypeChange={v => set('dsType', v)} datasources={MOCK_DATASOURCES} label="源数据源" />
          </div>
          <div className="tc-field">
            <label>目标数据源</label>
            <DatasourceSelect value={params.dtDatasource} typeValue={params.dtType} onChange={v => set('dtDatasource', v)} onTypeChange={v => set('dtType', v)} datasources={MOCK_DATASOURCES} label="目标数据源" />
          </div>
          <div className="tc-field">
            <label>前置SQL</label>
            <StatementsEditor items={params.preStatements} onChange={s => set('preStatements', s)} label="前置SQL语句" />
          </div>
          <div className="tc-field">
            <label>后置SQL</label>
            <StatementsEditor items={params.postStatements} onChange={s => set('postStatements', s)} label="后置SQL语句" />
          </div>
        </>
      )}
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function HiveCliForm({ params, onChange }: TaskFormProps<DSHiveCliTaskParams>) {
  const set = <K extends keyof DSHiveCliTaskParams>(key: K, val: DSHiveCliTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>执行类型</label>
        <select value={params.hiveCliTaskExecutionType} onChange={e => set('hiveCliTaskExecutionType', e.target.value as DSHiveCliTaskParams['hiveCliTaskExecutionType'])}>
          <option value="SCRIPT">脚本</option>
          <option value="FILE">文件</option>
        </select>
      </div>
      <div className="tc-field">
        <label>HiveSQL<span className="sm-required">*</span></label>
        <textarea className="tc-code" value={params.hiveSql} onChange={e => set('hiveSql', e.target.value)} placeholder="INSERT INTO TABLE target SELECT * FROM source" rows={8} />
      </div>
      <div className="tc-field">
        <label>HiveCLI参数</label>
        <input type="text" value={params.hiveCliArgs} onChange={e => set('hiveCliArgs', e.target.value)} placeholder="--hivevar key=value" />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function DmsForm({ params, onChange }: TaskFormProps<DSDmsTaskParams>) {
  const set = <K extends keyof DSDmsTaskParams>(key: K, val: DSDmsTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>DMS任务ID<span className="sm-required">*</span></label>
        <input type="text" value={params.dmsTaskId} onChange={e => set('dmsTaskId', e.target.value)} placeholder="任务ID" />
      </div>
      <div className="tc-field">
        <label className="tc-switch">
          <input type="checkbox" checked={params.isRestartTask} onChange={e => set('isRestartTask', e.target.checked)} />
          <span>重启任务</span>
        </label>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function DatasyncForm({ params, onChange }: TaskFormProps<DSDatasyncTaskParams>) {
  const set = <K extends keyof DSDatasyncTaskParams>(key: K, val: DSDatasyncTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>DataSync任务ID<span className="sm-required">*</span></label>
        <input type="text" value={params.datasyncTaskId} onChange={e => set('datasyncTaskId', e.target.value)} placeholder="任务ID" />
      </div>
      <div className="tc-field">
        <label>配置JSON</label>
        <textarea className="tc-code" value={params.datasyncConfigJSON} onChange={e => set('datasyncConfigJSON', e.target.value)} placeholder='{"type": "sync", "source": {}, "target": {}}' rows={8} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function KubeflowForm({ params, onChange }: TaskFormProps<DSKubeflowTaskParams>) {
  const set = <K extends keyof DSKubeflowTaskParams>(key: K, val: DSKubeflowTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>命名空间</label>
        <input type="text" value={params.kubeflowNamespace} onChange={e => set('kubeflowNamespace', e.target.value)} placeholder="kubeflow" />
      </div>
      <div className="tc-field">
        <label>Pipeline YAML<span className="sm-required">*</span></label>
        <textarea className="tc-code" value={params.kubeflowPipelineYaml} onChange={e => set('kubeflowPipelineYaml', e.target.value)} placeholder="apiVersion: pipelines.kubeflow.org/v1alpha5" rows={8} />
      </div>
      <div className="tc-field">
        <label>Pipeline参数</label>
        <LocalParamsEditor params={params.kubeflowParameters} onChange={p => set('kubeflowParameters', p)} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function LinkisForm({ params, onChange }: TaskFormProps<DSLinkisTaskParams>) {
  const set = <K extends keyof DSLinkisTaskParams>(key: K, val: DSLinkisTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label className="tc-switch">
          <input type="checkbox" checked={params.useCustom} onChange={e => set('useCustom', e.target.checked)} />
          <span>自定义脚本</span>
        </label>
      </div>
      {params.useCustom ? (
        <div className="tc-field">
          <label>脚本<span className="sm-required">*</span></label>
          <textarea className="tc-code" value={params.rawScript} onChange={e => set('rawScript', e.target.value)} placeholder="SELECT * FROM table" rows={8} />
        </div>
      ) : (
        <div className="tc-field">
          <label>JobContent</label>
          <textarea className="tc-code" value={params.linkisJobContent} onChange={e => set('linkisJobContent', e.target.value)} placeholder='{"code": "SELECT 1", "engineType": "spark"}' rows={6} />
        </div>
      )}
      <div className="tc-field">
        <label>参数脚本</label>
        <LocalParamsEditor params={params.paramScript} onChange={p => set('paramScript', p)} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>CPU配额</label>
          <input type="number" value={params.cpuQuota} onChange={e => set('cpuQuota', parseInt(e.target.value) || -1)} min={-1} />
        </div>
        <div className="tc-field">
          <label>最大内存(MB)</label>
          <input type="number" value={params.memoryMax} onChange={e => set('memoryMax', parseInt(e.target.value) || -1)} min={-1} />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function DataFactoryForm({ params, onChange }: TaskFormProps<DSDataFactoryTaskParams>) {
  const set = <K extends keyof DSDataFactoryTaskParams>(key: K, val: DSDataFactoryTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>工厂名称<span className="sm-required">*</span></label>
        <input type="text" value={params.factoryName} onChange={e => set('factoryName', e.target.value)} placeholder="Data Factory名称" />
      </div>
      <div className="tc-field">
        <label>资源组名称</label>
        <input type="text" value={params.resourceGroupName} onChange={e => set('resourceGroupName', e.target.value)} placeholder="资源组名称" />
      </div>
      <div className="tc-field">
        <label>Pipeline名称</label>
        <input type="text" value={params.pipelineName} onChange={e => set('pipelineName', e.target.value)} placeholder="Pipeline名称" />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function RemoteShellForm({ params, onChange }: TaskFormProps<DSRemoteShellTaskParams>) {
  const set = <K extends keyof DSRemoteShellTaskParams>(key: K, val: DSRemoteShellTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>SSH数据源</label>
        <DatasourceSelect value={params.datasource} typeValue="SSH" onChange={v => set('datasource', v)} onTypeChange={() => {}} datasources={MOCK_DATASOURCES} label="SSH数据源" />
      </div>
      <div className="tc-field">
        <label>脚本<span className="sm-required">*</span></label>
        <textarea className="tc-code" value={params.rawScript} onChange={e => set('rawScript', e.target.value)} placeholder="#!/bin/bash&#10;echo 'Hello Remote'" rows={8} />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>CPU配额</label>
          <input type="number" value={params.cpuQuota} onChange={e => set('cpuQuota', parseInt(e.target.value) || -1)} min={-1} />
        </div>
        <div className="tc-field">
          <label>最大内存(MB)</label>
          <input type="number" value={params.memoryMax} onChange={e => set('memoryMax', parseInt(e.target.value) || -1)} min={-1} />
        </div>
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export function AliyunServerlessSparkForm({ params, onChange }: TaskFormProps<DSAliyunServerlessSparkTaskParams>) {
  const set = <K extends keyof DSAliyunServerlessSparkTaskParams>(key: K, val: DSAliyunServerlessSparkTaskParams[K]) =>
    onChange({ ...params, [key]: val });

  return (
    <>
      <div className="tc-field">
        <label>RestEndpoint<span className="sm-required">*</span></label>
        <input type="text" value={params.restEndpoint} onChange={e => set('restEndpoint', e.target.value)} placeholder="https://xxx.cn-hangzhou.aliyuncs.com" />
      </div>
      <div className="tc-row">
        <div className="tc-field">
          <label>用户名</label>
          <input type="text" value={params.username} onChange={e => set('username', e.target.value)} placeholder="AccessKey ID" />
        </div>
        <div className="tc-field">
          <label>密码</label>
          <input type="password" value={params.password} onChange={e => set('password', e.target.value)} placeholder="AccessKey Secret" />
        </div>
      </div>
      <div className="tc-field">
        <label>Job ID</label>
        <input type="text" value={params.jobId} onChange={e => set('jobId', e.target.value)} placeholder="Spark Job ID" />
      </div>
      <div className="tc-field">
        <label>Job配置JSON</label>
        <textarea className="tc-code" value={params.sparkJobConfigJSON} onChange={e => set('sparkJobConfigJSON', e.target.value)} placeholder='{"name": "spark-job", "file": "oss://..."}' rows={8} />
      </div>
      <div className="tc-field">
        <label>自定义参数</label>
        <LocalParamsEditor params={params.localParams} onChange={p => set('localParams', p)} />
      </div>
    </>
  );
}

export const TASK_FORM_MAP: Record<DSTaskType, React.FC<TaskFormProps<any>>> = {
  SHELL: ShellForm,
  PYTHON: PythonForm,
  SQL: SqlForm,
  PROCEDURE: ProcedureForm,
  DATAX: DataXForm,
  SPARK: SparkForm,
  FLINK: FlinkForm,
  FLINK_STREAM: FlinkStreamForm,
  MR: MrForm,
  HTTP: HttpForm,
  SUB_PROCESS: SubProcessForm,
  DEPENDENT: DependentForm,
  CONDITIONS: ConditionsForm,
  SWITCH: SwitchForm,
  SEATUNNEL: SeaTunnelForm,
  K8S: K8sForm,
  JAVA: JavaForm,
  SQOOP: SqoopForm,
  GRPC: GrpcForm,
  EMR: EmrForm,
  ZEPPELIN: ZeppelinForm,
  JUPYTER: JupyterForm,
  MLFLOW: MlflowForm,
  OPENMLDB: OpenmldbForm,
  DVC: DvcForm,
  DINKY: DinkyForm,
  SAGEMAKER: SagemakerForm,
  CHUNJUN: ChunjunForm,
  HIVECLI: HiveCliForm,
  DMS: DmsForm,
  DATASYNC: DatasyncForm,
  KUBEFLOW: KubeflowForm,
  LINKIS: LinkisForm,
  DATA_FACTORY: DataFactoryForm,
  REMOTESHELL: RemoteShellForm,
  ALIYUN_SERVERLESS_SPARK: AliyunServerlessSparkForm,
};
