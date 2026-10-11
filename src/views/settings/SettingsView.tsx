import React, { useState } from 'react';
import { Settings, RotateCcw, Server, Sliders, Wifi, Loader2, Bot, Cpu, FileText, Trash2, Clock, Calendar, Info, Pencil, Check, X, Plug, CheckCircle, XCircle, Coffee, GitBranch, Plus, Boxes, AlertCircle, Download } from 'lucide-react';
import { type OpenCodeConfig, type LogEntry, type LLMModelConfig, isResponsesApiSupported, DEFAULT_POM_TEMPLATE } from '../../types/opencode-backend';
import { testDolphinSchedulerConnection } from '../../api/dolphinscheduler';
import { testMarquezConnection } from '../../api/marquez';
import { canExportConfig, exportDiagnosticConfig } from '../../utils/configExport';
import './SettingsView.css';

interface SettingsViewProps {
  config: OpenCodeConfig;
  onUpdateConfig: (partial: Partial<OpenCodeConfig>) => void;
  onResetConfig: () => void;
  logs: LogEntry[];
  onClearLogs: () => void;
}

type SettingsTab = 'basic' | 'agent' | 'logs' | 'jdtls';
type TestConnectionState = 'idle' | 'testing' | 'success' | 'error';

const getPlatformPlaceholders = (): Record<string, string> => {
  const isWindows = navigator.userAgent.includes('Windows');
  const isMac = navigator.platform?.includes('Mac') || navigator.userAgent.includes('Mac');

  if (isWindows) {
    return {
      sshKey: 'C:\\Users\\{username}\\.ssh\\id_rsa',
      python: 'python 或 C:\\Users\\{username}\\anaconda3\\python.exe',
      javaHome: 'C:\\Program Files\\Java\\jdk-17',
      mavenHome: 'C:\\apache-maven',
    };
  }

  if (isMac) {
    return {
      sshKey: '/Users/{username}/.ssh/id_rsa',
      python: '',
      javaHome: '/usr/lib/jvm/java-17',
      mavenHome: '/usr/local/maven',
    };
  }

  return {
    sshKey: '/home/{username}/.ssh/id_rsa',
    python: '/usr/bin/python3',
    javaHome: '/usr/lib/jvm/java-17',
    mavenHome: '/usr/local/maven',
  };
};

const placeholders = getPlatformPlaceholders();

const SettingsView: React.FC<SettingsViewProps> = ({
  config,
  onUpdateConfig,
  onResetConfig,
  logs,
  onClearLogs,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic');
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<Partial<OpenCodeConfig>>({});
  const [testState, setTestState] = useState<TestConnectionState>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [marquezTestState, setMarquezTestState] = useState<TestConnectionState>('idle');
  const [marquezTestMessage, setMarquezTestMessage] = useState('');

  // ── 诊断配置导出（凭据剥离在主进程完成） ──
  const [exportingConfig, setExportingConfig] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ── LLM 模型管理模态框 ──
  const [llmModalOpen, setLlmModalOpen] = useState(false);
  const [llmEditingId, setLlmEditingId] = useState<string | null>(null);
  const [llmDraft, setLlmDraft] = useState<LLMModelConfig>({
    id: '', name: '', providerID: 'deepseek', modelID: '', apiKey: '', baseUrl: '', useResponsesApi: false, reasoningEffort: 'high',
  });
  const [llmFormError, setLlmFormError] = useState('');

  const handleStartEdit = () => {
    setEditDraft({});
    setIsEditing(true);
    setTestState('idle');
    setTestMessage('');
  };

  const handleSaveEdit = () => {
    if (Object.keys(editDraft).length > 0) {
      onUpdateConfig(editDraft);
    }
    setEditDraft({});
    setIsEditing(false);
    setTestState('idle');
    setTestMessage('');
  };

  const handleCancelEdit = () => {
    setEditDraft({});
    setIsEditing(false);
    setTestState('idle');
    setTestMessage('');
  };

  const getFieldValue = <K extends keyof OpenCodeConfig>(key: K): OpenCodeConfig[K] => {
    const val = (editDraft[key] as OpenCodeConfig[K]) ?? config[key];
    return (val === null ? '' : val) as OpenCodeConfig[K];
  };

  const handleFieldChange = <K extends keyof OpenCodeConfig>(key: K, value: OpenCodeConfig[K]) => {
    setEditDraft(prev => ({ ...prev, [key]: value }));
  };

  const handleTestConnection = async () => {
    setTestState('testing');
    setTestMessage('');
    const result = await testDolphinSchedulerConnection(
      getFieldValue('dolphinSchedulerApiUrl'),
      getFieldValue('dolphinSchedulerToken'),
    );
    if (result.success) {
      setTestState('success');
      setTestMessage(result.message);
    } else {
      setTestState('error');
      setTestMessage(result.message);
    }
  };

  const handleTestMarquezConnection = async () => {
    setMarquezTestState('testing');
    setMarquezTestMessage('');
    const result = await testMarquezConnection(getFieldValue('marquezApiUrl'));
    if (result.success) {
      setMarquezTestState('success');
      setMarquezTestMessage(result.message);
    } else {
      setMarquezTestState('error');
      setMarquezTestMessage(result.message);
    }
  };

  // ── LLM 模型 CRUD ──

  /** 生成简单唯一 ID */
  const genLLMId = () => `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const openLLMCreate = () => {
    setLlmEditingId(null);
    setLlmDraft({ id: '', name: '', providerID: 'deepseek', modelID: '', apiKey: '', baseUrl: '', useResponsesApi: false, reasoningEffort: 'high' });
    setLlmFormError('');
    setLlmModalOpen(true);
  };

  const openLLMEdit = (model: LLMModelConfig) => {
    setLlmEditingId(model.id);
    // 兜底旧数据：useResponsesApi 缺失时按内置支持清单推断
    setLlmDraft({
      ...model,
      useResponsesApi: model.useResponsesApi ?? isResponsesApiSupported(model.providerID, model.modelID),
      reasoningEffort: model.reasoningEffort || 'high',
    });
    setLlmFormError('');
    setLlmModalOpen(true);
  };

  const closeLLMModal = () => {
    setLlmModalOpen(false);
    setLlmEditingId(null);
    setLlmFormError('');
  };

  const saveLLMDraft = () => {
    const name = llmDraft.name.trim();
    const providerID = llmDraft.providerID.trim();
    const modelID = llmDraft.modelID.trim();
    if (!name) { setLlmFormError('请填写模型名称'); return; }
    if (!providerID) { setLlmFormError('请选择提供商'); return; }
    if (!modelID) { setLlmFormError('请填写模型 ID'); return; }

    const current = config.llmModels ?? [];
    // 内置支持模型强制启用 Responses API（不可关闭）
    const forcedResponsesApi = isResponsesApiSupported(providerID, modelID);
    const useResponsesApi = forcedResponsesApi || llmDraft.useResponsesApi;
    // 思考强度：必选，缺失时兜底为 high
    const reasoningEffort: LLMModelConfig['reasoningEffort'] = (llmDraft.reasoningEffort?.trim() || 'high') as LLMModelConfig['reasoningEffort'];
    let next: LLMModelConfig[];
    if (llmEditingId) {
      next = current.map(m => m.id === llmEditingId
        ? { ...m, name, providerID, modelID, apiKey: llmDraft.apiKey, baseUrl: llmDraft.baseUrl, useResponsesApi, reasoningEffort }
        : m);
    } else {
      next = [...current, {
        id: genLLMId(),
        name,
        providerID,
        modelID,
        apiKey: llmDraft.apiKey,
        baseUrl: llmDraft.baseUrl,
        useResponsesApi,
        reasoningEffort,
      }];
    }
    onUpdateConfig({ llmModels: next });
    closeLLMModal();
  };

  const deleteLLMModel = (id: string) => {
    const current = config.llmModels ?? [];
    onUpdateConfig({ llmModels: current.filter(m => m.id !== id) });
  };

  /** 导出诊断配置：凭据已在主进程侧替换为 ***，失败必须显式提示，不能静默 */
  const handleExportConfig = async () => {
    setExportingConfig(true);
    setExportResult(null);
    try {
      const { filename, storeCount } = await exportDiagnosticConfig();
      setExportResult({ ok: true, text: `已导出 ${storeCount} 个配置文件：${filename}（凭据已剥离）` });
    } catch (err) {
      setExportResult({ ok: false, text: err instanceof Error ? `导出失败：${err.message}` : '导出失败' });
    } finally {
      setExportingConfig(false);
    }
  };

  return (
    <div className="settings-view" style={{ width: '100%', height: '100%' }}>
      <div className="settings-view__header">
        <div className="settings-view__title">
          <Settings size={20} />
          <span>设置</span>
        </div>
      </div>

      <div className="settings-view__tabs">
        <button
          className={`settings-view__tab ${activeTab === 'basic' ? 'settings-view__tab--active' : ''}`}
          onClick={() => setActiveTab('basic')}
        >
          <Sliders size={16} />
          <span>基础功能设置</span>
        </button>
        <button
          className={`settings-view__tab ${activeTab === 'agent' ? 'settings-view__tab--active' : ''}`}
          onClick={() => setActiveTab('agent')}
        >
          <Bot size={16} />
          <span>智能体相关设置</span>
        </button>
{/*         <button
          className={`settings-view__tab ${activeTab === 'logs' ? 'settings-view__tab--active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          <FileText size={16} />
          <span>智能体运行日志</span>
          {logs.length > 0 && (
            <span className="settings-view__tab-badge">{logs.length}</span>
          )}
        </button>
        <button
          className={`settings-view__tab ${activeTab === 'jdtls' ? 'settings-view__tab--active' : ''}`}
          onClick={() => setActiveTab('jdtls')}
        >
          <Activity size={16} />
          <span>JDT.LS 日志</span>
          {jdtlsLogs.length > 0 && (
            <span className="settings-view__tab-badge">{jdtlsLogs.length}</span>
          )}
        </button> */}
      </div>

      <div className="settings-view__content">
        {activeTab === 'basic' && (
          <div className="settings-view__panel">
            <section className="settings-section">
              <div className="settings-section__header">
                <Server size={14} />
                <span>数据血缘服务</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">Marquez API 地址</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('marquezApiUrl')}
                  onChange={e => handleFieldChange('marquezApiUrl', e.target.value)}
                  readOnly={!isEditing}
                  maxLength={255}
                  placeholder="请输入 Marquez API 地址"
                />
                <span className="settings-field__hint">Marquez 数据血缘服务 API 地址，用于数据血缘追踪和元数据管理</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">OpenLineage Transport URL</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('openlineageTransportUrl')}
                  onChange={e => handleFieldChange('openlineageTransportUrl', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="http://openlineage.com"
                />
                <span className="settings-field__hint">OpenLineage 数据血缘传输地址，提交 Spark 调度任务时自动注入 spark.openlineage.transport.url 参数</span>
              </div>
              {isEditing && getFieldValue('marquezApiUrl') && (
                <div className="settings-field settings-field--test-connection">
                  <button
                    className="settings-view__btn settings-view__btn--test"
                    onClick={handleTestMarquezConnection}
                    disabled={marquezTestState === 'testing'}
                  >
                    {marquezTestState === 'testing' ? <Loader2 size={12} className="settings-section__spinner" /> : <Plug size={12} />}
                    {marquezTestState === 'testing' ? '测试中...' : '测试连接'}
                  </button>
                  {marquezTestState === 'success' && (
                    <span className="settings-field__test-result settings-field__test-result--success">
                      <CheckCircle size={12} />
                      {marquezTestMessage}
                    </span>
                  )}
                  {marquezTestState === 'error' && (
                    <span className="settings-field__test-result settings-field__test-result--error">
                      <XCircle size={12} />
                      {marquezTestMessage}
                    </span>
                  )}
                </div>
              )}
            </section>

            <section className="settings-section">
              <div className="settings-section__header">
                <GitBranch size={14} />
                <span>Git 仓库配置</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">仓库地址</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('gitRepoUrl')}
                  onChange={e => handleFieldChange('gitRepoUrl', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="https://github.com/example/repo.git 或 git@github.com:example/repo.git"
                />
                <span className="settings-field__hint">Git 仓库的远程地址（支持 HTTPS 和 SSH 协议）。留空时在本地初始化名为 warehouse 的仓库</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">SSH 私钥路径（免密配置）</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('gitSshKeyPath')}
                  onChange={e => handleFieldChange('gitSshKeyPath', e.target.value)}
                  readOnly={!isEditing}
                  placeholder={placeholders.sshKey}
                />
                <span className="settings-field__hint">SSH 私钥文件路径，用于免密克隆和拉取代码。如果使用 HTTPS 地址且需要密码，请配置 Git Credential Helper 或改用 SSH 地址</span>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section__header">
                <Coffee size={14} />
                <span>Java/Scala 环境</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">JAVA_HOME</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('javaHome')}
                  onChange={e => handleFieldChange('javaHome', e.target.value)}
                  readOnly={!isEditing}
                  placeholder={placeholders.javaHome}
                />
                <span className="settings-field__hint">JDK 安装目录路径（如 /Library/Java/JavaVirtualMachines/temurin-21/Contents/Home），编译运行 Java/Scala 及代码智能提示时使用</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">MAVEN_HOME</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('mavenHome')}
                  onChange={e => handleFieldChange('mavenHome', e.target.value)}
                  readOnly={!isEditing}
                  placeholder={placeholders.mavenHome}
                />
                <span className="settings-field__hint">Maven 安装目录，编译 Java/Scala 程序时使用；不填写时使用系统 PATH 中的 mvn</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">Scala 版本</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('scalaVersion')}
                  onChange={e => handleFieldChange('scalaVersion', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="2.12.21"
                />
                <span className="settings-field__hint">编译 Scala 程序时使用的 Scala 版本（如 2.12.21、2.12.18、3.3.1）；不填写时默认 2.12.21</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">Maven groupId</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('mavenGroupId')}
                  onChange={e => handleFieldChange('mavenGroupId', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="com.dataforge"
                />
                <span className="settings-field__hint">编译生成的 pom.xml 中的 groupId；不填写时默认 com.dataforge</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">Maven artifactId</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('mavenArtifactId')}
                  onChange={e => handleFieldChange('mavenArtifactId', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="data_procs"
                />
                <span className="settings-field__hint">编译生成的 pom.xml 中的 artifactId；不填写时默认 data_procs</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">POM 模板</label>
                <textarea
                  className={`settings-field__textarea ${!isEditing ? 'settings-field__textarea--readonly' : ''}`}
                  value={getFieldValue('pomTemplate') || DEFAULT_POM_TEMPLATE}
                  onChange={e => handleFieldChange('pomTemplate', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="在此输入自定义 Maven pom.xml 模板..."
                  rows={16}
                />
                <span className="settings-field__hint">Maven pom.xml 模板。可用占位符: {`{group_id}`} (groupId), {`{artifact_id}`} (artifactId), {`{main_class}`} (主类), {`{final_name}`} (JAR文件名), {`{scala_version}`}, {`{deps}`}, {`{scala_plugin}`}</span>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section__header">
                <Calendar size={14} />
                <span>DolphinScheduler 调度系统</span>
                {getFieldValue('dolphinSchedulerApiUrl') && getFieldValue('dolphinSchedulerToken') ? (
                  <span className="settings-section__badge settings-section__badge--connected">
                    <Wifi size={10} />
                    已配置
                  </span>
                ) : (
                  <span className="settings-section__badge settings-section__badge--starting">
                    <Info size={10} />
                    未配置
                  </span>
                )}
              </div>
              <div className="settings-field">
                <label className="settings-field__label">API URL</label>
                <input
                  type="text"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('dolphinSchedulerApiUrl')}
                  onChange={e => handleFieldChange('dolphinSchedulerApiUrl', e.target.value)}
                  readOnly={!isEditing}
                  maxLength={255}
                  placeholder="请输入 DolphinScheduler API 地址"
                />
                <span className="settings-field__hint">DolphinScheduler API 服务地址，未配置时使用模拟数据</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">API Token</label>
                <input
                  type="password"
                  className={`settings-field__input ${!isEditing ? 'settings-field__input--readonly' : ''}`}
                  value={getFieldValue('dolphinSchedulerToken')}
                  onChange={e => handleFieldChange('dolphinSchedulerToken', e.target.value)}
                  readOnly={!isEditing}
                  placeholder="在安全中心-令牌管理中生成"
                />
                <span className="settings-field__hint">在 DolphinScheduler 的「安全中心 → 令牌管理」中生成 API Token</span>
              </div>
              {isEditing && getFieldValue('dolphinSchedulerApiUrl') && getFieldValue('dolphinSchedulerToken') && (
                <div className="settings-field settings-field--test-connection">
                  <button
                    className="settings-view__btn settings-view__btn--test"
                    onClick={handleTestConnection}
                    disabled={testState === 'testing'}
                  >
                    {testState === 'testing' ? <Loader2 size={12} className="settings-section__spinner" /> : <Plug size={12} />}
                    {testState === 'testing' ? '测试中...' : '测试连接'}
                  </button>
                  {testState === 'success' && (
                    <span className="settings-field__test-result settings-field__test-result--success">
                      <CheckCircle size={12} />
                      {testMessage}
                    </span>
                  )}
                  {testState === 'error' && (
                    <span className="settings-field__test-result settings-field__test-result--error">
                      <XCircle size={12} />
                      {testMessage}
                    </span>
                  )}
                </div>
              )}
            </section>

            <section className="settings-section">
              <div className="settings-section__header">
                <Download size={14} />
                <span>诊断配置导出</span>
              </div>
              <div className="settings-field">
                <span className="settings-field__hint">
                  把本机全部配置文件（userData/df-stores）打包成一个 JSON，用于排查问题或留档。
                  导出前会在主进程侧把 API Key、令牌、口令等凭据字段替换为 ***，可直接发给他人；
                  凭据本身在磁盘上也已由系统钥匙串加密，不再以明文存储。
                </span>
              </div>
              {canExportConfig() && (
                <div className="settings-field settings-field--test-connection">
                  <button
                    className="settings-view__btn settings-view__btn--test"
                    onClick={handleExportConfig}
                    disabled={exportingConfig}
                  >
                    {exportingConfig ? <Loader2 size={12} className="settings-section__spinner" /> : <Download size={12} />}
                    {exportingConfig ? '导出中...' : '导出诊断配置'}
                  </button>
                  {exportResult && (
                    <span className={`settings-field__test-result ${exportResult.ok ? 'settings-field__test-result--success' : 'settings-field__test-result--error'}`}>
                      {exportResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      {exportResult.text}
                    </span>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'agent' && (
          <div className="settings-view__panel">
            {/* LLM 模型管理：允许配置多个 LLM，供 AIPanel 运行时切换 */}
            <section className="settings-section">
              <div className="settings-section__header">
                <Boxes size={14} />
                <span>LLM 模型管理</span>
                {(config.llmModels?.length ?? 0) > 0 && (
                  <span className="settings-section__badge settings-section__badge--connected">
                    已配置 {config.llmModels.length} 个
                  </span>
                )}
                <button
                  className="settings-view__btn settings-view__btn--edit"
                  onClick={openLLMCreate}
                  style={{ marginLeft: 'auto' }}
                >
                  <Plus size={12} />
                  新增模型
                </button>
              </div>
              <div className="settings-field__hint" style={{ marginBottom: 8 }}>
                在此配置的 LLM 模型会出现在 AI 面板顶部的下拉框中，可在对话过程中随时切换。留空 API 密钥/Base URL 时回退到上方的全局配置。
              </div>
              {(config.llmModels?.length ?? 0) === 0 ? (
                <div className="settings-llm-empty">
                  <Boxes size={28} strokeWidth={1} />
                  <span>暂无配置，点击"新增模型"添加</span>
                </div>
              ) : (
                <div className="settings-llm-list">
                  {config.llmModels.map(model => (
                    <div className="settings-llm-item" key={model.id}>
                      <div className="settings-llm-item-icon">
                        <Cpu size={14} />
                      </div>
                      <div className="settings-llm-item-main">
                        <div className="settings-llm-item-name">{model.name}</div>
                        <div className="settings-llm-item-meta">
                          <span className="settings-llm-item-provider">{model.providerID}</span>
                          <span className="settings-llm-item-modelid">{model.modelID}</span>
                          {model.baseUrl && <span className="settings-llm-item-baseurl" title={model.baseUrl}>{model.baseUrl}</span>}
                        </div>
                      </div>
                      <div className="settings-llm-item-actions">
                        <button
                          className="settings-view__btn"
                          onClick={() => openLLMEdit(model)}
                          title="编辑"
                        >
                          <Pencil size={12} />
                          编辑
                        </button>
                        <button
                          className="settings-view__btn settings-view__btn--cancel"
                          onClick={() => deleteLLMModel(model.id)}
                          title="删除"
                        >
                          <Trash2 size={12} />
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="settings-view__panel settings-view__panel--logs">
            <div className="logs-header">
              <div className="logs-header__info">
                <Clock size={14} />
                <span>共 {logs.length} 条日志</span>
              </div>
              <button
                className="settings-view__btn settings-view__btn--clear"
                onClick={onClearLogs}
                disabled={logs.length === 0}
              >
                <Trash2 size={12} />
                清空日志
              </button>
            </div>

            <div className="logs-container">
              {logs.length === 0 ? (
                <div className="logs-empty">
                  <FileText size={48} strokeWidth={1} />
                  <p>暂无运行日志</p>
                  <span>启动 Agent 服务后，日志将在此显示</span>
                </div>
              ) : (
                <div className="logs-list">
                  {logs.map((log, index) => (
                    <div
                      key={index}
                      className={`log-entry log-entry--${log.source}`}
                    >
                      <div className="log-entry__header">
                        <span className="log-entry__timestamp">
                          {new Date(log.timestamp).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                        <span className={`log-entry__source log-entry__source--${log.source}`}>
                          {log.source.toUpperCase()}
                        </span>
                      </div>
                      <div className="log-entry__content">
                        {log.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="settings-view__footer">
        <div className="settings-view__footer-left">
          <button className="settings-view__btn settings-view__btn--reset" onClick={onResetConfig}>
            <RotateCcw size={12} />
            重置默认
          </button>
        </div>
        <div className="settings-view__footer-right">
          {isEditing ? (
            <>
              <button className="settings-view__btn settings-view__btn--cancel" onClick={handleCancelEdit}>
                <X size={12} />
                取消
              </button>
              <button className="settings-view__btn settings-view__btn--save" onClick={handleSaveEdit}>
                <Check size={12} />
                保存
              </button>
            </>
          ) : (
            <button className="settings-view__btn settings-view__btn--edit" onClick={handleStartEdit}>
              <Pencil size={12} />
              编辑
            </button>
          )}
          <div className="settings-view__status">
            配置已自动保存到本地存储
          </div>
        </div>
      </div>

      {/* LLM 模型新增/编辑模态框 */}
      {llmModalOpen && (
        <div className="settings-llm-modal-overlay" onClick={closeLLMModal}>
          <div className="settings-llm-modal" onClick={e => e.stopPropagation()}>
            <div className="settings-llm-modal__header">
              <div className="settings-llm-modal__title">
                <Cpu size={16} />
                <span>{llmEditingId ? '编辑 LLM 模型' : '新增 LLM 模型'}</span>
              </div>
              <button className="settings-llm-modal__close" onClick={closeLLMModal} title="关闭">
                <X size={14} />
              </button>
            </div>
            <div className="settings-llm-modal__body">
              <div className="settings-field">
                <label className="settings-field__label">模型名称 *</label>
                <input
                  type="text"
                  className="settings-field__input"
                  value={llmDraft.name}
                  onChange={e => setLlmDraft(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="如：DeepSeek-V3、GPT-4o"
                  autoFocus
                />
                <span className="settings-field__hint">显示在 AIPanel 下拉框中的名称</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">提供商 *</label>
                <select
                  className="settings-field__select"
                  value={llmDraft.providerID}
                  onChange={e => {
                    const newProviderID = e.target.value;
                    const supported = isResponsesApiSupported(newProviderID, llmDraft.modelID);
                    setLlmDraft(prev => ({ ...prev, providerID: newProviderID, useResponsesApi: supported ? true : prev.useResponsesApi }));
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="deepseek-relay">DeepSeek Relay</option>
                  <option value="doubao">豆包 (Doubao)</option>
                  <option value="qwen">通义千问 (Qwen)</option>
                  <option value="zhipu">智谱 (Zhipu)</option>
                  <option value="gemini">Gemini</option>
                  <option value="ollama">Ollama</option>
                  <option value="lm-studio">LM Studio</option>
                  <option value="custom">自定义</option>
                </select>
                <span className="settings-field__hint">模型 API 提供商</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">模型 ID *</label>
                <input
                  type="text"
                  className="settings-field__input"
                  value={llmDraft.modelID}
                  onChange={e => {
                    const newModelID = e.target.value;
                    const supported = isResponsesApiSupported(llmDraft.providerID, newModelID);
                    setLlmDraft(prev => ({ ...prev, modelID: newModelID, useResponsesApi: supported ? true : prev.useResponsesApi }));
                  }}
                  placeholder={
                    { openai: 'gpt-4o', deepseek: 'deepseek-chat', 'deepseek-relay': 'deepseek-chat', doubao: 'doubao-pro-32k', qwen: 'qwen-plus', zhipu: 'glm-4', gemini: 'gemini-2.0-flash', ollama: 'llama3', 'lm-studio': 'local-model' }[llmDraft.providerID] || '自定义模型 ID'
                  }
                />
                <span className="settings-field__hint">对应 Agent 中的 modelID</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">API 密钥</label>
                <input
                  type="password"
                  className="settings-field__input"
                  value={llmDraft.apiKey}
                  onChange={e => setLlmDraft(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder="留空则使用全局 API Key"
                />
                <span className="settings-field__hint">可选；留空时回退到上方"API 密钥"全局配置</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">Base URL</label>
                <input
                  type="text"
                  className="settings-field__input"
                  value={llmDraft.baseUrl}
                  onChange={e => setLlmDraft(prev => ({ ...prev, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                />
                <span className="settings-field__hint">可选；custom/ollama/lm-studio 等需要填写</span>
              </div>
              <div className="settings-field">
                <label className="settings-field__label">思考强度 (reasoningEffort) *</label>
                <select
                  className="settings-field__select"
                  value={llmDraft.reasoningEffort}
                  onChange={e => {
                    const val = e.target.value as LLMModelConfig['reasoningEffort'];
                    setLlmDraft(prev => ({ ...prev, reasoningEffort: val }));
                  }}
                >
                  <option value="low">low - 低推理</option>
                  <option value="medium">medium - 中等推理</option>
                  <option value="high">high - 高推理</option>
                  <option value="xhigh">xhigh - 超高推理</option>
                </select>
                <span className="settings-field__hint">控制模型推理/思考的深度，必选，默认 high。仅对支持思考的模型（如 qwen3-*、deepseek-v4-flash）生效，更改后需重启应用生效</span>
              </div>
              {llmFormError && (
                <div className="settings-llm-modal__error">
                  <AlertCircle size={12} />
                  <span>{llmFormError}</span>
                </div>
              )}
            </div>
            <div className="settings-llm-modal__footer">
              <button className="settings-view__btn settings-view__btn--cancel" onClick={closeLLMModal}>
                <X size={12} />
                取消
              </button>
              <button className="settings-view__btn settings-view__btn--save" onClick={saveLLMDraft}>
                <Check size={12} />
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsView;
