/** 需要从血缘展示中过滤掉的节点 ID 后缀 */
const HIDDEN_NODE_SUFFIXES = ['.adaptive_spark_plan', '.deserialize_to_object'];

/** 判断节点 ID 是否属于需要隐藏的中间节点（用于搜索结果过滤与关系图过滤） */
export function shouldHideNode(nodeId: string): boolean {
  return HIDDEN_NODE_SUFFIXES.some((suffix) => nodeId.endsWith(suffix));
}