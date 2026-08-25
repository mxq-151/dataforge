import React, { useState, useEffect } from 'react';
import AIPanel from '../../components/ai/AIPanel';
import DataExploreEditor from './DataExploreEditor';
import DBTableBrowser from './DBTableBrowser';
import TableDetail from './TableDetail';
import { useDataSourceCache } from '../../contexts/DataSourceContext';

import type { OpencodeClientBackend } from '../../components/ai/types';
import type { LLMModelConfig } from '../../types/opencode-backend';

interface DataExploreViewProps {
  chatBackend: OpencodeClientBackend;
  llmModels?: LLMModelConfig[];
  /** 基础工作目录（$HOME/.dataforge/{后端host}/{登录用户名}/） */
  baseWorkspace?: string;
}

const DataExploreView: React.FC<DataExploreViewProps> = ({ chatBackend, llmModels, baseWorkspace }) => {
  const { refresh } = useDataSourceCache();
  const [selectedDataSourceId, setSelectedDataSourceId] = useState<number | null>(null);
  const [selectedDetailDatasourceId, setSelectedDetailDatasourceId] = useState<number | null>(null);
  const [selectedStorageEngine, setSelectedStorageEngine] = useState<string>('');
  const [selectedDatabaseName, setSelectedDatabaseName] = useState<string>('');
  const [selectedTableName, setSelectedTableName] = useState<string>('');

  // 日志：监控 fileChange 状态传递
  useEffect(() => {
    console.log('[DF::DataExploreView] chatBackend.lastFileChangeSeq=', chatBackend.lastFileChangeSeq, 'lastFileChangePaths=', chatBackend.lastFileChangePaths);
  }, [chatBackend.lastFileChangeSeq, chatBackend.lastFileChangePaths]);

  // 打开数据探索模块时加载库表信息
  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleTableDetail = (datasourceId: number, storageEngine: string, databaseName: string, tableName: string) => {
    setSelectedDetailDatasourceId(datasourceId);
    setSelectedStorageEngine(storageEngine);
    setSelectedDatabaseName(databaseName);
    setSelectedTableName(tableName);
  };

  const handleCloseDetail = () => {
    setSelectedDetailDatasourceId(null);
    setSelectedStorageEngine('');
    setSelectedDatabaseName('');
    setSelectedTableName('');
  };

  return (
    <>
      <AIPanel chatBackend={chatBackend} llmModels={llmModels} moduleId="data-explore" projectId="__data_explore__" />
      <DataExploreEditor
        selectedDataSourceId={selectedDataSourceId}
        onDataSourceChange={setSelectedDataSourceId}
        lastFileChangeSeq={chatBackend.lastFileChangeSeq}
        lastFileChangePaths={chatBackend.lastFileChangePaths}
        baseWorkspace={baseWorkspace}
      />
      <DBTableBrowser
        dataSourceId={selectedDataSourceId}
        onTableDetail={handleTableDetail}
      />
      <TableDetail
        datasourceId={selectedDetailDatasourceId}
        storageEngine={selectedStorageEngine}
        databaseName={selectedDatabaseName}
        tableName={selectedTableName}
        onClose={handleCloseDetail}
      />
    </>
  );
};

export default DataExploreView;
