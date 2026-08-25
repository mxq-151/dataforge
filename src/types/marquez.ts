export type NodeType = 'DATASET' | 'DATASET_FIELD' | 'JOB' | 'RUN';

export interface DatasetId {
  namespace: string;
  name: string;
}

export interface DatasetField {
  name: string;
  type: string;
  tags: string[];
}

export interface DatasetData {
  id: DatasetId;
  type: string;
  name: string;
  physicalName: string;
  createdAt: string;
  updatedAt: string;
  namespace: string;
  sourceName: string;
  fields: DatasetField[];
  tags: string[];
  lastModifiedAt: string | null;
  description: string | null;
  facets: Record<string, unknown>;
  currentVersion: string;
}

export interface JobData {
  id: DatasetId;
  type: string;
  name: string;
  namespace: string;
  inputs: DatasetId[];
  outputs: DatasetId[];
  currentRunUuid: string | null;
  latestRun: RunData | null;
  location: string | null;
  description: string | null;
  facets: Record<string, unknown>;
}

export interface RunData {
  id: string;
  start: string | null;
  end: string | null;
  status: string;
  facets: Record<string, unknown>;
}

export interface ColumnLineageInputField {
  namespace: string;
  dataset: string;
  field: string;
  transformationDescription: string | null;
  transformationType: string | null;
}

export interface ColumnLineageNodeData {
  namespace: string;
  dataset: string;
  field: string;
  fieldType: string;
  inputFields: ColumnLineageInputField[];
}

export type NodeData = DatasetData | JobData | ColumnLineageNodeData;

export interface Edge {
  origin: string;
  destination: string;
}

export interface LineageNode {
  id: string;
  type: NodeType;
  data: NodeData;
  inEdges: Edge[];
  outEdges: Edge[];
}

export interface Lineage {
  graph: LineageNode[];
}

export interface Namespace {
  name: string;
  createdAt: string;
  updatedAt: string;
  ownerName: string;
  description: string;
}

export interface NamespaceList {
  namespaces: Namespace[];
}

export type SearchResultType = 'DATASET' | 'JOB';

export interface SearchResult {
  type: SearchResultType;
  name: string;
  updatedAt: string;
  namespace: string;
  nodeId: string;
}

export interface SearchResponse {
  totalCount: number;
  results: SearchResult[];
}

export interface LineageEvent {
  eventType: string;
  eventTime: string;
  run: {
    runId: string;
    facets: Record<string, unknown>;
  };
  job: {
    namespace: string;
    name: string;
    facets: Record<string, unknown>;
  };
  inputs: Array<{
    namespace: string;
    name: string;
    facets: Record<string, unknown>;
  }>;
  outputs: Array<{
    namespace: string;
    name: string;
    facets: Record<string, unknown>;
  }>;
  producer: string;
  schemaURL: string;
}

export interface LineageEventsResponse {
  events: LineageEvent[];
  totalCount: number;
}

export interface DatasetList {
  datasets: DatasetData[];
  totalCount: number;
}

export interface MarquezApi {
  lineage: {
    get(nodeId: string, depth?: number): Promise<Lineage>;
    getColumnLineage(nodeId: string, depth?: number, withDownstream?: boolean): Promise<Lineage>;
  };
  namespaces: {
    list(limit?: number, offset?: number): Promise<NamespaceList>;
  };
  datasets: {
    list(namespace: string, limit?: number, offset?: number): Promise<DatasetList>;
    get(namespace: string, dataset: string): Promise<DatasetData>;
  };
  search: {
    query(q: string, filter?: string, sort?: string, limit?: number, namespace?: string): Promise<SearchResponse>;
  };
  events: {
    list(limit?: number, offset?: number): Promise<LineageEventsResponse>;
  };
}
