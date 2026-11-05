/**
 * 指标领域的数据传输对象。
 *
 * 原先定义在 api/indicator.ts，但 utils/extractMetrics.ts（基础设施层）需要用它们做
 * Markdown 解析，导致 utils 反向依赖 api 层。DTO 是领域模型而非接口实现细节，
 * 下沉到 types 供各层共用；api/indicator.ts 仍 re-export 以保持既有引用可用。
 */

export interface IndicatorFieldDTO {
  datasourceName: string;
  dbName: string;
  tblName: string;
  fieldName: string;
  fieldType: string;
}

export interface IndicatorDTO {
  id?: number;
  projectCode: string;
  topic: string;
  name: string;
  code?: string;
  businessDefinition?: string;
  calcExpr?: string;
  defaultFilter?: string;
  alertConfig?: string;
  businessOwner?: string;
  techOwner?: string;
  refreshInterval?: number;
  refreshUnit?: string;
  refreshDesc?: string;
  visibility?: string;
  fields?: IndicatorFieldDTO[];
}
