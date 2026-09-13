import { createTimeout, ensureOkWithBody } from './httpCore';
import type {
  DolphinSchedulerResponse,
  DSWorkflowDefinition,
  DSWorkflowTaskNode,
  DSWorkflowEdge,
  DSWorkflowGlobalParam,
  DolphinSchedulerApi,
  DSScheduleForm,
  DSScheduleParam,
} from '../types/dolphinscheduler';
import {
  ReleaseState,
  ExecutionType,
  parseReleaseState,
  releaseStateToString,
} from '../types/dolphinscheduler';

const toQueryParams = (params: Record<string, unknown>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      result[k] = String(v);
    }
  }
  return result;
};

function buildTaskDefinitionJson(nodes: DSWorkflowTaskNode[]): string {
  return JSON.stringify(nodes.map(n => {
    let taskParamsObj: Record<string, unknown>;
    if (typeof n.taskParams === 'string') {
      try {
        taskParamsObj = JSON.parse(n.taskParams);
      } catch {
        taskParamsObj = {};
      }
    } else {
      taskParamsObj = n.taskParams as Record<string, unknown> || {};
    }

    if (typeof taskParamsObj.mainJar === 'string' && taskParamsObj.mainJar) {
      taskParamsObj.mainJar = { resourceName: taskParamsObj.mainJar };
    }

    if (Array.isArray(taskParamsObj.resourceList)) {
      const mapped = (taskParamsObj.resourceList as unknown[]).map((item: unknown) => {
        if (typeof item === 'string' && item) {
          return { resourceName: item };
        }
        return item;
      });
      // resourceList 为空数组时移除该字段，避免向 DS 提交多余的 resourceList
      if (mapped.length === 0) {
        delete taskParamsObj.resourceList;
      } else {
        taskParamsObj.resourceList = mapped;
      }
    }

    return {
      code: n.code,
      delayTime: String(n.delayTime ?? 0),
      description: n.description || '',
      environmentCode: n.environmentCode ?? -1,
      failRetryInterval: String(n.failRetryInterval ?? 1),
      failRetryTimes: String(n.failRetryTimes ?? 0),
      flag: n.flag || 'YES',
      name: n.name,
      taskParams: taskParamsObj,
      taskPriority: n.taskPriority || 'MEDIUM',
      taskType: n.taskType,
      timeout: n.timeout ?? 0,
      timeoutFlag: n.timeoutFlag || 'CLOSE',
      timeoutNotifyStrategy: n.timeoutNotifyStrategy || '',
      workerGroup: n.workerGroup || 'default',
      cpuQuota: n.cpuQuota ?? -1,
      memoryMax: n.memoryMax ?? -1,
      taskExecuteType: n.taskExecuteType || 'BATCH',
    };
  }));
}

function buildTaskRelationJson(nodes: DSWorkflowTaskNode[], edges: DSWorkflowEdge[]): string {
  const relations = edges.map(e => {
    const targetNode = nodes.find(n => n.code === e.targetCode);
    return {
      name: '',
      preTaskCode: e.sourceCode,
      preTaskVersion: 0,
      postTaskCode: e.targetCode,
      postTaskVersion: targetNode?.version ?? 0,
      conditionType: e.conditionType || 'NONE',
      conditionParams: typeof e.conditionParams === 'string' && e.conditionParams ? JSON.parse(e.conditionParams || '{}') : (e.conditionParams || {}),
    };
  });

  const nodesWithPredecessor = new Set(edges.map(e => e.targetCode));
  for (const node of nodes) {
    if (!nodesWithPredecessor.has(node.code)) {
      relations.push({
        name: '',
        preTaskCode: 0,
        preTaskVersion: 0,
        postTaskCode: node.code,
        postTaskVersion: node.version ?? 0,
        conditionType: 'NONE',
        conditionParams: {},
      });
    }
  }

  return JSON.stringify(relations);
}

function buildLocationsJson(nodes: DSWorkflowTaskNode[]): string {
  return JSON.stringify(nodes.map(n => ({
    taskCode: n.code,
    x: n.x,
    y: n.y,
  })));
}

export function createRealDolphinSchedulerApi(apiUrl: string, token: string): DolphinSchedulerApi {
  const baseUrl = apiUrl.replace(/\/+$/, '');
  const trimmedToken = token.trim();

  const dsRequest = async <T>(
    path: string,
    options: {
      method?: string;
      params?: Record<string, unknown>;
      body?: unknown;
      formData?: Record<string, string>;
    } = {},
  ): Promise<T> => {
    const { method = 'GET', params, body, formData } = options;
    let fullUrl = `${baseUrl}${path}`;

    const queryParams: Record<string, string> = params ? toQueryParams(params) : {};
    const qs = Object.entries(queryParams)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) fullUrl += `?${qs}`;

    const headers: Record<string, string> = { token: trimmedToken };
    let reqBody: string | undefined;

    if (formData) {
      const fd = new URLSearchParams();
      for (const [k, v] of Object.entries(formData)) {
        fd.append(k, v);
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      reqBody = fd.toString();
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }

    const { signal, dispose } = createTimeout();

    try {
      const res = await fetch(fullUrl, {
        method,
        headers,
        signal,
        body: method !== 'GET' ? reqBody : undefined,
      });

      await ensureOkWithBody(res);

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Expected JSON response but got ${contentType}: ${text.substring(0, 200)}`);
      }

      const jsonData = await res.json();
      return jsonData as T;
    } finally {
      dispose();
    }
  };

  return {
    project: {
      list(params) {
        return dsRequest('/projects', { params: toQueryParams(params as Record<string, unknown>) });
      },
      create(data) {
        return dsRequest('/projects', {
          method: 'POST',
          formData: data as unknown as Record<string, string>,
        });
      },
      update(projectCode, data) {
        return dsRequest(`/projects/${projectCode}`, {
          method: 'PUT',
          formData: data as unknown as Record<string, string>,
        });
      },
      delete(projectCode) {
        return dsRequest(`/projects/${projectCode}`, { method: 'DELETE' });
      },
    },

    workflowDefinition: {
      list(projectCode, params) {
        return dsRequest(`/projects/${projectCode}/workflow-definition`, {
          params: toQueryParams(params as Record<string, unknown>),
        });
      },

      detail(projectCode, code) {
        return dsRequest<DolphinSchedulerResponse<any>>(`/projects/${projectCode}/workflow-definition/${code}`)
          .then((res) => {
            if (!res || typeof res !== 'object') {
              throw new Error(`Invalid response format: expected object but got ${typeof res}`);
            }

            if (res.code !== 0 || !res.data) {
              throw new Error(`API error ${res.code}: ${res.msg || 'No data in response'}`);
            }

            const raw = res.data;

            if (!raw || typeof raw !== 'object') {
              throw new Error(`Invalid data field: expected object but got ${typeof raw}`);
            }

            let taskDefinitionList: any[] = [];
            let taskRelationList: any[] = [];
            let processDef: any = raw;

            if (raw.processDefinition && typeof raw.processDefinition === 'object') {
              processDef = raw.processDefinition;
            } else if (raw.workflowDefinition && typeof raw.workflowDefinition === 'object') {
              processDef = raw.workflowDefinition;
            }

            if (Array.isArray(raw.taskDefinitionList)) {
              taskDefinitionList = raw.taskDefinitionList;
            } else if (Array.isArray(processDef.taskDefinitionList)) {
              taskDefinitionList = processDef.taskDefinitionList;
            }

            if (Array.isArray(raw.taskRelationList)) {
              taskRelationList = raw.taskRelationList;
            } else if (Array.isArray(processDef.taskRelationList)) {
              taskRelationList = processDef.taskRelationList;
            } else if (Array.isArray(raw.workflowTaskRelationList)) {
              // 实际 DS 接口返回字段为 data.workflowTaskRelationList（edgeList），
              // taskRelationList 在旧版/文档接口中作为兼容别名保留
              taskRelationList = raw.workflowTaskRelationList;
            }

            const locationsMap = new Map<number, { x: number; y: number }>();
            try {
              let locationsStr = processDef.locations || raw.locations || '[]';

              if (locationsStr && locationsStr !== '[]' && typeof locationsStr === 'string') {
                const locations = JSON.parse(locationsStr);
                if (Array.isArray(locations)) {
                  locations.forEach((loc: any) => {
                    if (loc && loc.taskCode && typeof loc.x === 'number' && typeof loc.y === 'number') {
                      locationsMap.set(loc.taskCode, { x: loc.x, y: loc.y });
                    }
                  });
                }
              }
            } catch { /* use defaults */ }

            let globalParams: DSWorkflowGlobalParam[] = [];
            try {
              let gpStr = processDef.globalParams || raw.globalParams || '[]';
              if (gpStr && gpStr !== '[]' && typeof gpStr === 'string') {
                const gp = JSON.parse(gpStr);
                if (Array.isArray(gp)) {
                  globalParams = gp;
                }
              }
            } catch { /* use defaults */ }

            const taskNodes: DSWorkflowTaskNode[] = [];
            for (let i = 0; i < taskDefinitionList.length; i++) {
              const td = taskDefinitionList[i];
              if (!td || !td.code || !td.name || !td.taskType) {
                continue;
              }

              const loc = locationsMap.get(td.code) || {
                // 无历史坐标时的默认网格位置：每行 3 个，横向间距 450、纵向间距 260，避免节点紧挨
                x: 300 + (taskNodes.length % 3) * 450,
                y: 140 + Math.floor(taskNodes.length / 3) * 260
              };

              taskNodes.push({
                code: td.code,
                name: td.name,
                taskType: td.taskType,
                description: td.description || '',
                taskParams: typeof td.taskParams === 'string' ? td.taskParams : JSON.stringify(td.taskParams || {}),
                flag: td.flag || 'YES',
                taskPriority: td.taskPriority || 'MEDIUM',
                workerGroup: td.workerGroup || 'default',
                environmentCode: td.environmentCode ?? -1,
                failRetryTimes: td.failRetryTimes ?? 0,
                failRetryInterval: td.failRetryInterval ?? 1,
                timeoutFlag: td.timeoutFlag || 'CLOSE',
                timeout: td.timeout ?? 0,
                delayTime: td.delayTime ?? 0,
                x: loc.x,
                y: loc.y,
                id: td.id,
                version: td.version,
                taskExecuteType: td.taskExecuteType || 'BATCH',
                cpuQuota: td.cpuQuota ?? -1,
                memoryMax: td.memoryMax ?? -1,
                timeoutNotifyStrategy: td.timeoutNotifyStrategy || '',
                taskGroupId: td.taskGroupId ?? null,
                taskGroupPriority: td.taskGroupPriority ?? null,
              });
            }

            const edges: DSWorkflowEdge[] = [];
            for (let i = 0; i < taskRelationList.length; i++) {
              const tr = taskRelationList[i];
              if (!tr || !tr.postTaskCode) {
                console.warn('[Real API] Skipping invalid task relation at index', i, tr);
                continue;
              }
              // preTaskCode 为 0 表示工作流头节点（无前置任务），非真实依赖边，静默跳过
              if (!tr.preTaskCode) continue;

              edges.push({
                id: `e_${tr.preTaskCode}_${tr.postTaskCode}`,
                sourceCode: tr.preTaskCode,
                targetCode: tr.postTaskCode,
                conditionType: tr.conditionType,
                conditionParams: typeof tr.conditionParams === 'string' ? tr.conditionParams : JSON.stringify(tr.conditionParams || '{}'),
              });
            }

            if (processDef.code === undefined || processDef.code === null) {
              console.warn('[DS API] workflowDefinition code is missing in detail response. raw keys:', Object.keys(raw), 'processDef keys:', Object.keys(processDef));
            }

            return {
              code: 0,
              msg: res.msg || 'success',
              data: {
                workflowDefinition: {
                  id: processDef.id,
                  code: processDef.code,
                  name: processDef.name,
                  version: processDef.version ?? 1,
                  description: processDef.description || '',
                  projectCode: processDef.projectCode || projectCode,
                  projectName: processDef.projectName || '',
                  releaseState: parseReleaseState(processDef.releaseState),
                  userId: processDef.userId ?? 0,
                  userName: processDef.userName || '',
                  globalParams: typeof processDef.globalParams === 'string' ? processDef.globalParams : JSON.stringify(globalParams),
                  locations: typeof processDef.locations === 'string' ? processDef.locations : JSON.stringify(Array.from(locationsMap.entries()).map(([taskCode, pos]) => ({ taskCode, ...pos }))),
                  warningGroupId: processDef.warningGroupId ?? 0,
                  timeout: processDef.timeout ?? 0,
                  executionType: processDef.executionType ?? ExecutionType.PARALLEL,
                  createTime: processDef.createTime || '',
                  updateTime: processDef.updateTime || '',
                } as DSWorkflowDefinition,
                taskNodes,
                edges,
                globalParams,
              },
            };
          });
      },

      create(projectCode, data) {
        return dsRequest(`/projects/${projectCode}/workflow-definition`, {
          method: 'POST',
          formData: {
            name: data.name,
            description: data.description || '',
            taskDefinitionJson: '[]',
            taskRelationJson: '[]',
            globalParams: '[]',
            locations: '[]',
            timeout: '0',
            tenantCode: 'default',
          },
        });
      },

      createWithTasks(projectCode, data) {
        const executionTypeStr = ExecutionType[data.executionType] || 'PARALLEL';
        return dsRequest(`/projects/${projectCode}/workflow-definition`, {
          method: 'POST',
          formData: {
            name: data.name,
            description: data.description || '',
            taskDefinitionJson: buildTaskDefinitionJson(data.nodes),
            taskRelationJson: buildTaskRelationJson(data.nodes, data.edges),
            globalParams: JSON.stringify(data.globalParams),
            locations: buildLocationsJson(data.nodes),
            timeout: String(data.timeout),
            executionType: executionTypeStr,
            tenantCode: 'default',
          },
        });
      },

      update(projectCode, code, data) {
        const executionTypeStr = ExecutionType[data.executionType] || 'PARALLEL';
        return dsRequest(`/projects/${projectCode}/workflow-definition/${code}`, {
          method: 'PUT',
          formData: {
            name: data.name,
            description: data.description || '',
            taskDefinitionJson: buildTaskDefinitionJson(data.nodes),
            taskRelationJson: buildTaskRelationJson(data.nodes, data.edges),
            globalParams: JSON.stringify(data.globalParams),
            locations: buildLocationsJson(data.nodes),
            timeout: String(data.timeout),
            executionType: executionTypeStr,
            releaseState: data.release ? releaseStateToString(ReleaseState.ONLINE) : releaseStateToString(ReleaseState.OFFLINE),
            tenantCode: 'default',
          },
        });
      },

      release(projectCode, code, releaseState) {
        return dsRequest(`/projects/${projectCode}/workflow-definition/${code}/release`, {
          method: 'POST',
          formData: { releaseState: releaseStateToString(releaseState) },
        });
      },

      delete(projectCode, code) {
        return dsRequest(`/projects/${projectCode}/workflow-definition/${code}`, { method: 'DELETE' });
      },

      trigger(projectCode, params) {
        const formData: Record<string, string> = {
          workflowDefinitionCode: String(params.processDefinitionCode),
          scheduleTime: params.scheduleTime || '',
          failureStrategy: params.failureStrategy || 'END',
          warningType: params.warningType || 'NONE',
          warningGroupId: String(params.warningGroupId ?? 0),
          runMode: 'RUN_MODE_SERIAL',
          processInstancePriority: params.processInstancePriority || 'MEDIUM',
          workerGroup: params.workerGroup || 'default',
          dryRun: String(params.dryRun ?? 0),
        };
        if (params.environmentCode !== undefined && params.environmentCode !== null) {
          formData.environmentCode = String(params.environmentCode);
        }
        if (params.tenantCode) {
          formData.tenantCode = params.tenantCode;
        }
        if (params.startParams && params.startParams.length > 0) {
          formData.startParamsList = JSON.stringify(
            params.startParams
              .filter(p => p && p.key)
              .map(p => ({ prop: p.key, direct: 'IN', type: 'VARCHAR', value: p.value || '' })),
          );
        }
        if (params.complementRun) {
          formData.execType = 'COMPLEMENT_DATA';
          formData.commandType = 'COMPLEMENT_DATA';
        }
        return dsRequest(`/projects/${projectCode}/executors/start-workflow-instance`, {
          method: 'POST',
          formData,
        });
      },
    },

    workflowInstance: {
      list(params) {
        const projectCode = params.projectCode;
        const { projectCode: _pc, ...rest } = params as any;
        return dsRequest(`/projects/${projectCode}/workflow-instances`, {
          params: toQueryParams(rest as Record<string, unknown>),
        });
      },

      detail(id, projectCode) {
        return dsRequest(`/projects/${projectCode}/workflow-instances/${id}/`);
      },

      tasks(id, projectCode) {
        return dsRequest(`/projects/${projectCode}/workflow-instances/${id}/tasks`);
      },

      execute(id, executeType, projectCode) {
        const pc = projectCode || '0';
        return dsRequest(`/projects/${pc}/executors/execute`, {
          method: 'POST',
          formData: {
            workflowInstanceId: String(id),
            executeType,
          },
        });
      },
    },

    taskInstance: {
      list(params) {
        const projectCode = params.projectCode;
        const { projectCode: _pc, ...rest } = params as any;
        return dsRequest(`/projects/${projectCode}/task-instances`, {
          params: toQueryParams(rest as Record<string, unknown>),
        });
      },

      log(_projectCode, taskInstanceId) {
        return dsRequest('/log/detail', {
          params: { taskInstanceId, skipLineNum: 0, limit: 8192 },
        });
      },

      forceSuccess(taskInstanceId, projectCode) {
        const pc = projectCode || '0';
        return dsRequest(`/projects/${pc}/task-instances/${taskInstanceId}/force-success`, {
          method: 'POST',
        });
      },
    },
    datasource: {
      list(params) {
        return dsRequest('/datasources', {
          method: 'GET',
          params: { pageNo: params.pageNo, pageSize: params.pageSize, searchVal: params.searchVal },
        });
      },
    },

    workerGroup: {
      list(projectCode, params) {
        return dsRequest(`/projects/${projectCode}/worker-group`, {
          method: 'GET',
          params: toQueryParams(params as Record<string, unknown>),
        });
      },
    },

    tenant: {
      list(params) {
        return dsRequest('/tenants/list', {
          method: 'GET',
          params: toQueryParams(params as Record<string, unknown>),
        });
      },
    },

    alertGroup: {
      list(params) {
        return dsRequest('/alert-groups/list', {
          method: 'GET',
          params: toQueryParams(params as Record<string, unknown>),
        });
      },
    },

    environment: {
      list(params) {
        return dsRequest('/environment/query-environment-list', {
          method: 'GET',
          params: toQueryParams(params as Record<string, unknown>),
        });
      },
    },

    resource: {
      async upload(data) {
        const formData = new FormData();
        formData.append('type', data.type);
        formData.append('name', data.name);
        formData.append('file', data.file);
        formData.append('currentDir', data.currentDir);

        // 上传资源耗时较长，放宽超时到 120s
        const { signal, dispose } = createTimeout(120_000);

        try {
          const res = await fetch(`${baseUrl}/resources`, {
            method: 'POST',
            headers: { token: trimmedToken },
            body: formData,
            signal,
          });

          await ensureOkWithBody(res);

          return await res.json();
        } finally {
          dispose();
        }
      },

      list(type) {
        return dsRequest('/resources/list', {
          params: { type },
        });
      },

      queryBaseDir(type) {
        return dsRequest('/resources/base-dir', {
          params: { type },
        });
      },

      async createDir(data) {
        const formData = new FormData();
        formData.append('type', data.type);
        formData.append('name', data.name);
        formData.append('currentDir', data.currentDir);
        if (data.description) {
          formData.append('description', data.description);
        }

        const { signal, dispose } = createTimeout();

        try {
          const res = await fetch(`${baseUrl}/resources/directory`, {
            method: 'POST',
            headers: { token: trimmedToken },
            body: formData,
            signal,
          });

          await ensureOkWithBody(res);

          return await res.json();
        } finally {
          dispose();
        }
      },
    },

    schedule: {
      list(projectCode, params) {
        return dsRequest(`/projects/${projectCode}/schedules`, {
          method: 'GET',
          params: toQueryParams(params as unknown as Record<string, unknown>),
        });
      },

      create(projectCode, workflowDefinitionCode, form) {
        return dsRequest(`/projects/${projectCode}/schedules`, {
          method: 'POST',
          formData: buildScheduleFormData(workflowDefinitionCode, form),
        });
      },

      update(projectCode, scheduleId, workflowDefinitionCode, form) {
        return dsRequest(`/projects/${projectCode}/schedules/${scheduleId}`, {
          method: 'PUT',
          formData: buildScheduleFormData(workflowDefinitionCode, form),
        });
      },

      delete(projectCode, scheduleId) {
        return dsRequest(`/projects/${projectCode}/schedules/${scheduleId}`, { method: 'DELETE' });
      },

      online(projectCode, scheduleId) {
        return dsRequest(`/projects/${projectCode}/schedules/${scheduleId}/online`, { method: 'POST' });
      },

      offline(projectCode, scheduleId) {
        return dsRequest(`/projects/${projectCode}/schedules/${scheduleId}/offline`, { method: 'POST' });
      },

      /**
       * 预览 crontab 的下 N 次触发时间。
       *
       * 该接口在 DS 各版本里的返回形态不统一：多数版本是 `Result.data = string[]`，
       * 也有版本直接返回裸数组；这里统一归一化成 `DolphinSchedulerResponse<string[]>`，
       * 让调用方只处理一种形状（渲染层另有本地推导作为兜底）。
       */
      async preview(projectCode, param) {
        const raw: any = await dsRequest(`/projects/${projectCode}/schedules/preview`, {
          method: 'POST',
          body: param,
        });
        if (Array.isArray(raw)) {
          return { code: 0, msg: 'success', data: raw as string[] };
        }
        const list = raw?.data;
        if (Array.isArray(list)) {
          return { code: raw.code ?? 0, msg: raw.msg ?? 'success', data: list as string[] };
        }
        if (Array.isArray(list?.totalList)) {
          return { code: raw.code ?? 0, msg: raw.msg ?? 'success', data: list.totalList as string[] };
        }
        return { code: raw?.code ?? 0, msg: raw?.msg ?? 'success', data: [] };
      },
    },
  };
}

/**
 * 组装 DS 定时调度接口的表单参数。
 *
 * DS 把「生效区间 + crontab + 时区」这四项打包成一个 `schedule` JSON 串，
 * 其余调度属性平铺在表单里，两者混在同一个 form-data 中提交
 * （见 ScheduleCreateRequest#getScheduleParam）。
 */
function buildScheduleFormData(
  workflowDefinitionCode: number,
  form: DSScheduleForm,
): Record<string, string> {
  const param: DSScheduleParam = {
    startTime: form.startTime,
    endTime: form.endTime,
    crontab: form.crontab.trim(),
    timezoneId: form.timezoneId,
  };

  const data: Record<string, string> = {
    workflowDefinitionCode: String(workflowDefinitionCode),
    schedule: JSON.stringify(param),
    failureStrategy: form.failureStrategy || 'CONTINUE',
    warningType: form.warningType || 'NONE',
    warningGroupId: String(form.warningGroupId ?? 0),
    workflowInstancePriority: form.workflowInstancePriority || 'MEDIUM',
    workerGroup: form.workerGroup || 'default',
  };

  // -1 表示「默认环境」，DS 侧用 environmentCode 缺省即代表默认，这里不传更干净；
  // 但租户必须显式传（DS 缺省会取当前用户名，语义上不对）。
  if (form.environmentCode !== null && form.environmentCode !== undefined) {
    data.environmentCode = String(form.environmentCode);
  }
  if (form.tenantCode) {
    data.tenantCode = form.tenantCode;
  }

  return data;
}

export async function testDolphinSchedulerConnection(apiUrl: string, token: string): Promise<{ success: boolean; message: string }> {
  try {
    const baseUrl = apiUrl.replace(/\/+$/, '');
    const trimmedToken = token.trim();
    const url = `${baseUrl}/projects?pageSize=1&pageNo=1`;
    const { signal, dispose } = createTimeout(10_000);
    try {
      const res = await fetch(url, {
        signal,
        headers: { token: trimmedToken },
      });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
      }
      const data = await res.json();
      if (data.code === 0) {
        return { success: true, message: '连接成功' };
      }
      return { success: false, message: data.msg || `API 返回错误码: ${data.code}` };
    } finally {
      dispose();
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, message: '连接超时，请检查服务地址是否正确' };
    }
    return { success: false, message: e.message || '连接失败' };
  }
}
