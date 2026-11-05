import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData, DatasetData, JobData, ColumnLineageNodeData } from '../../types/marquez';
import { Database, Cog, FileText } from 'lucide-react';

function isDatasetData(data: NodeData): data is DatasetData {
  return 'physicalName' in data;
}

function isJobData(data: NodeData): data is JobData {
  return 'inputs' in data && 'outputs' in data;
}

function isColumnLineageData(data: NodeData): data is ColumnLineageNodeData {
  return 'fieldType' in data;
}

function getNodeLabel(data: NodeData): string {
  if (isColumnLineageData(data)) {
    return `${data.dataset}.${data.field}`;
  }
  if (isDatasetData(data)) {
    return data.name;
  }
  if (isJobData(data)) {
    return data.name;
  }
  return 'Unknown';
}

function getNodeDescription(data: NodeData): string {
  if (isColumnLineageData(data)) {
    return `${data.fieldType}`;
  }
  if (isDatasetData(data)) {
    return data.namespace;
  }
  if (isJobData(data)) {
    return data.namespace;
  }
  return '';
}

interface LineageNodeData {
  nodeData: NodeData;
  [key: string]: unknown;
}

const DatasetNode = memo(({ data, selected }: NodeProps) => {
  const nodeData = (data as unknown as LineageNodeData).nodeData;
  const label = getNodeLabel(nodeData);
  const desc = getNodeDescription(nodeData);

  return (
    <div className={`lineage-node lineage-node--dataset ${selected ? 'lineage-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="lineage-handle lineage-handle--target" />
      <div className="lineage-node__icon">
        <Database size={14} />
      </div>
      <div className="lineage-node__content">
        <div className="lineage-node__label" title={label}>{label}</div>
        {desc && <div className="lineage-node__desc" title={desc}>{desc}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="lineage-handle lineage-handle--source" />
    </div>
  );
});
DatasetNode.displayName = 'DatasetNode';

const JobNode = memo(({ data, selected }: NodeProps) => {
  const nodeData = (data as unknown as LineageNodeData).nodeData;
  const label = getNodeLabel(nodeData);
  const desc = getNodeDescription(nodeData);

  return (
    <div className={`lineage-node lineage-node--job ${selected ? 'lineage-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="lineage-handle lineage-handle--target" />
      <div className="lineage-node__icon">
        <Cog size={14} />
      </div>
      <div className="lineage-node__content">
        <div className="lineage-node__label" title={label}>{label}</div>
        {desc && <div className="lineage-node__desc" title={desc}>{desc}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="lineage-handle lineage-handle--source" />
    </div>
  );
});
JobNode.displayName = 'JobNode';

const FieldNode = memo(({ data, selected }: NodeProps) => {
  const nodeData = (data as unknown as LineageNodeData).nodeData;
  const label = getNodeLabel(nodeData);
  const desc = getNodeDescription(nodeData);

  return (
    <div className={`lineage-node lineage-node--field ${selected ? 'lineage-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="lineage-handle lineage-handle--target" />
      <div className="lineage-node__icon">
        <FileText size={14} />
      </div>
      <div className="lineage-node__content">
        <div className="lineage-node__label" title={label}>{label}</div>
        {desc && <div className="lineage-node__desc" title={desc}>{desc}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="lineage-handle lineage-handle--source" />
    </div>
  );
});
FieldNode.displayName = 'FieldNode';

export const nodeTypes = {
  dataset: DatasetNode,
  job: JobNode,
  field: FieldNode,
};

export { DatasetNode, JobNode, FieldNode };
