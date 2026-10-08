import { useCallback, useRef } from 'react';
import type { DataSource, TableInfo, ColumnInfo } from '../api/datasource';
import { fetchTableColumns } from '../api/datasource';

// ========== SQL 关键词 ==========
const SQL_KEYWORDS = [
  { label: 'SELECT', detail: '查询' },
  { label: 'FROM', detail: '指定数据源' },
  { label: 'WHERE', detail: '过滤条件' },
  { label: 'AND', detail: '逻辑与' },
  { label: 'OR', detail: '逻辑或' },
  { label: 'NOT', detail: '逻辑非' },
  { label: 'IN', detail: '在集合中' },
  { label: 'EXISTS', detail: '存在判断' },
  { label: 'BETWEEN', detail: '范围查询' },
  { label: 'LIKE', detail: '模糊匹配' },
  { label: 'IS', detail: '空值判断' },
  { label: 'NULL', detail: '空值' },
  { label: 'AS', detail: '别名' },
  { label: 'ON', detail: '连接条件' },
  { label: 'JOIN', detail: '内连接' },
  { label: 'INNER JOIN', detail: '内连接' },
  { label: 'LEFT JOIN', detail: '左连接' },
  { label: 'LEFT OUTER JOIN', detail: '左外连接' },
  { label: 'RIGHT JOIN', detail: '右连接' },
  { label: 'RIGHT OUTER JOIN', detail: '右外连接' },
  { label: 'FULL JOIN', detail: '全连接' },
  { label: 'FULL OUTER JOIN', detail: '全外连接' },
  { label: 'CROSS JOIN', detail: '交叉连接' },
  { label: 'GROUP BY', detail: '分组' },
  { label: 'ORDER BY', detail: '排序' },
  { label: 'HAVING', detail: '分组过滤' },
  { label: 'LIMIT', detail: '限制行数' },
  { label: 'OFFSET', detail: '偏移量' },
  { label: 'UNION', detail: '合并去重' },
  { label: 'UNION ALL', detail: '合并不去重' },
  { label: 'INTERSECT', detail: '交集' },
  { label: 'EXCEPT', detail: '差集' },
  { label: 'INSERT INTO', detail: '插入数据' },
  { label: 'VALUES', detail: '插入值' },
  { label: 'UPDATE', detail: '更新数据' },
  { label: 'SET', detail: '设置值' },
  { label: 'DELETE FROM', detail: '删除数据' },
  { label: 'CREATE TABLE', detail: '创建表' },
  { label: 'ALTER TABLE', detail: '修改表' },
  { label: 'DROP TABLE', detail: '删除表' },
  { label: 'TRUNCATE TABLE', detail: '清空表' },
  { label: 'CREATE DATABASE', detail: '创建数据库' },
  { label: 'DROP DATABASE', detail: '删除数据库' },
  { label: 'USE', detail: '选择数据库' },
  { label: 'SHOW', detail: '显示信息' },
  { label: 'DESCRIBE', detail: '描述结构' },
  { label: 'DESC', detail: '描述结构(简写)' },
  { label: 'DISTINCT', detail: '去重' },
  { label: 'CASE', detail: '条件表达式' },
  { label: 'WHEN', detail: '条件分支' },
  { label: 'THEN', detail: '条件结果' },
  { label: 'ELSE', detail: '默认分支' },
  { label: 'END', detail: '条件结束' },
  { label: 'CAST', detail: '类型转换' },
  { label: 'WITH', detail: 'CTE 公共表表达式' },
  { label: 'OVER', detail: '窗口函数' },
  { label: 'PARTITION BY', detail: '窗口分区' },
  { label: 'ROWS BETWEEN', detail: '窗口范围' },
  { label: 'ASC', detail: '升序' },
  { label: 'DESC', detail: '降序' },
  { label: 'TRUE', detail: '布尔真' },
  { label: 'FALSE', detail: '布尔假' },
  { label: 'IF', detail: '条件判断' },
  { label: 'INTO', detail: '插入目标' },
  { label: 'TABLE', detail: '表' },
  { label: 'DATABASE', detail: '数据库' },
  { label: 'SCHEMA', detail: '模式' },
  { label: 'VIEW', detail: '视图' },
  { label: 'INDEX', detail: '索引' },
  { label: 'TEMPORARY', detail: '临时' },
  { label: 'EXTERNAL', detail: '外部' },
  { label: 'PARTITIONED BY', detail: '分区' },
  { label: 'STORED AS', detail: '存储格式' },
  { label: 'LOCATION', detail: '存储位置' },
  { label: 'ALL', detail: '全部' },
  { label: '*', detail: '所有列' },
  // ===== 事务控制 =====
  { label: 'BEGIN', detail: '开始事务' },
  { label: 'START TRANSACTION', detail: '开始事务' },
  { label: 'COMMIT', detail: '提交事务' },
  { label: 'ROLLBACK', detail: '回滚事务' },
  // ===== 权限管理 =====
  { label: 'GRANT', detail: '授权' },
  { label: 'REVOKE', detail: '撤销权限' },
  // ===== 查询分析 =====
  { label: 'EXPLAIN', detail: '执行计划' },
  // ===== 子查询 =====
  { label: 'ANY', detail: '任意匹配' },
  { label: 'SOME', detail: '存在匹配' },
  // ===== CTE =====
  { label: 'RECURSIVE', detail: '递归CTE' },
  // ===== JOIN =====
  { label: 'NATURAL', detail: '自然连接' },
  { label: 'USING', detail: '连接列名' },
  // ===== 窗口过滤 =====
  { label: 'QUALIFY', detail: '窗口过滤' },
  // ===== DML =====
  { label: 'MERGE', detail: '合并操作' },
  { label: 'REPLACE INTO', detail: '替换插入' },
  // ===== 存储过程 =====
  { label: 'CALL', detail: '调用存储过程' },
  // ===== 数组/集合 =====
  { label: 'UNNEST', detail: '展开数组' },
  // ===== ALTER TABLE 子句 =====
  { label: 'ADD', detail: '添加列/约束' },
  { label: 'COLUMN', detail: '列' },
  { label: 'CONSTRAINT', detail: '约束' },
  { label: 'FOREIGN', detail: '外键' },
  { label: 'REFERENCES', detail: '引用' },
  { label: 'CHECK', detail: '检查约束' },
  { label: 'KEY', detail: '键' },
  { label: 'CASCADE', detail: '级联' },
  { label: 'RESTRICT', detail: '限制' },
  // ===== UPSERT 冲突处理 =====
  { label: 'DO', detail: '冲突处理' },
  { label: 'NOTHING', detail: '跳过操作' },
  // ===== 模糊匹配 =====
  { label: 'ILIKE', detail: '不区分大小写匹配' },
  // ===== Hive 关键词 =====
  { label: 'LATERAL VIEW', detail: 'Hive侧视图' },
  { label: 'LATERAL VIEW OUTER', detail: 'Hive外连接侧视图' },
  { label: 'CLUSTER BY', detail: 'Hive分桶排序' },
  { label: 'DISTRIBUTE BY', detail: 'Hive分桶' },
  { label: 'SORT BY', detail: 'Hive排序' },
  { label: 'TABLESAMPLE', detail: 'Hive抽样' },
  { label: 'MSCK REPAIR TABLE', detail: 'Hive修复分区' },
  { label: 'LOAD DATA', detail: 'Hive加载数据' },
  { label: 'OVERWRITE', detail: 'Hive覆盖写入' },
  { label: 'ROW FORMAT', detail: 'Hive行格式' },
  { label: 'SERDE', detail: 'Hive序列化' },
  { label: 'FIELDS TERMINATED BY', detail: 'Hive字段分隔符' },
  { label: 'COLLECTION ITEMS TERMINATED BY', detail: 'Hive集合分隔符' },
  { label: 'MAP KEYS TERMINATED BY', detail: 'Hive Map键分隔符' },
  { label: 'LINES TERMINATED BY', detail: 'Hive行分隔符' },
  { label: 'STORED AS INPUTFORMAT', detail: 'Hive输入格式' },
  { label: 'STORED AS OUTPUTFORMAT', detail: 'Hive输出格式' },
  { label: 'TBLPROPERTIES', detail: 'Hive表属性' },
  { label: 'COMPUTE STATISTICS', detail: 'Hive计算统计' },
  { label: 'ANALYZE TABLE', detail: 'Hive分析表' },
  { label: 'REFRESH', detail: 'Hive刷新元数据' },
  { label: 'CACHE TABLE', detail: 'Hive缓存表' },
  { label: 'UNCACHE TABLE', detail: 'Hive取消缓存' },
  { label: 'ADD JAR', detail: 'Hive添加JAR' },
  { label: 'ADD FILE', detail: 'Hive添加文件' },
  { label: 'CLUSTERED BY', detail: 'Hive分桶' },
  { label: 'SKEWED BY', detail: 'Hive倾斜键' },
  { label: 'STORED BY', detail: 'Hive存储处理器' },
  // ===== Doris 关键词 =====
  { label: 'DUPLICATE KEY', detail: 'Doris明细模型' },
  { label: 'AGGREGATE KEY', detail: 'Doris聚合模型' },
  { label: 'UNIQUE KEY', detail: 'Doris主键模型' },
  { label: 'DISTRIBUTED BY HASH', detail: 'Doris哈希分布' },
  { label: 'DISTRIBUTED BY RANDOM', detail: 'Doris随机分布' },
  { label: 'BROKER', detail: 'Doris Broker导入' },
  { label: 'PROPERTIES', detail: 'Doris属性配置' },
  { label: 'REPLACE_IF_NOT_NULL', detail: 'Doris非空替换' },
  { label: 'HLL_UNION', detail: 'Doris HLL聚合' },
  { label: 'BITMAP_UNION', detail: 'Doris Bitmap聚合' },
  { label: 'ROLLUP', detail: 'Doris上卷' },
  { label: 'REPOSITORY', detail: 'Doris仓库' },
  { label: 'SYNC', detail: 'Doris同步' },
  { label: 'NEGATIVE', detail: 'Doris负向' },
  { label: 'CANCEL ALTER', detail: 'Doris取消变更' },
  { label: 'INSTALL PLUGIN', detail: 'Doris安装插件' },
  { label: 'UNINSTALL PLUGIN', detail: 'Doris卸载插件' },
  { label: 'SHOW BACKUP', detail: 'Doris显示备份' },
  { label: 'SHOW RESTORE', detail: 'Doris显示恢复' },
  { label: 'SHOW LOAD', detail: 'Doris显示导入' },
  { label: 'SHOW EXPORT', detail: 'Doris显示导出' },
  { label: 'SHOW DATA', detail: 'Doris显示数据分布' },
  { label: 'SHOW TABLET', detail: 'Doris显示分片' },
  { label: 'SHOW PROC', detail: 'Doris显示进程' },
  { label: 'SHOW ROUTINE LOAD', detail: 'Doris显示例行导入' },
  { label: 'SHOW STREAM LOAD', detail: 'Doris显示流式导入' },
  { label: 'SHOW TRANSACTION', detail: 'Doris显示事务' },
  { label: 'SHOW COLLATION', detail: 'Doris显示排序规则' },
  { label: 'SHOW TRIGGERS', detail: 'Doris显示触发器' },
  { label: 'SHOW VIEW', detail: 'Doris显示视图' },
  { label: 'SHOW EVENT', detail: 'Doris显示事件' },
  { label: 'SHOW FRONTENDS', detail: 'Doris显示FE节点' },
  { label: 'SHOW BACKENDS', detail: 'Doris显示BE节点' },
  { label: 'SHOW BROKER', detail: 'Doris显示Broker' },
  { label: 'ADMIN SET', detail: 'Doris管理设置' },
  { label: 'ADMIN SHOW', detail: 'Doris管理显示' },
  { label: 'STORAGE POLICY', detail: 'Doris存储策略' },
  { label: 'RESOURCE', detail: 'Doris资源' },
  { label: 'RECOVER', detail: 'Doris恢复' },
  { label: 'FORCE', detail: 'Doris强制' },
  // ===== ClickHouse 关键词 =====
  { label: 'ENGINE', detail: 'ClickHouse表引擎' },
  { label: 'MergeTree', detail: 'ClickHouse合并树引擎' },
  { label: 'ReplacingMergeTree', detail: 'ClickHouse去重合并树' },
  { label: 'SummingMergeTree', detail: 'ClickHouse求和合并树' },
  { label: 'AggregatingMergeTree', detail: 'ClickHouse聚合合并树' },
  { label: 'CollapsingMergeTree', detail: 'ClickHouse折叠合并树' },
  { label: 'VersionedCollapsingMergeTree', detail: 'ClickHouse版本折叠合并树' },
  { label: 'GraphiteMergeTree', detail: 'ClickHouse时序合并树' },
  { label: 'ARRAY JOIN', detail: 'ClickHouse数组连接' },
  { label: 'GLOBAL JOIN', detail: 'ClickHouse全局连接' },
  { label: 'GLOBAL IN', detail: 'ClickHouse全局IN' },
  { label: 'PREWHERE', detail: 'ClickHouse预过滤' },
  { label: 'FINAL', detail: 'ClickHouse最终数据' },
  { label: 'SAMPLE', detail: 'ClickHouse采样' },
  { label: 'SAMPLE BY', detail: 'ClickHouse采样键' },
  { label: 'FORMAT', detail: 'ClickHouse输出格式' },
  { label: 'SETTINGS', detail: 'ClickHouse配置' },
  { label: 'TTL', detail: 'ClickHouse生存时间' },
  { label: 'MATERIALIZED', detail: 'ClickHouse物化' },
  { label: 'MATERIALIZE', detail: 'ClickHouse物化操作' },
  { label: 'POPULATE', detail: 'ClickHouse填充' },
  { label: 'Nullable', detail: 'ClickHouse可空类型' },
  { label: 'LowCardinality', detail: 'ClickHouse低基数列' },
  { label: 'EPHEMERAL', detail: 'ClickHouse临时列' },
  { label: 'ALIAS', detail: 'ClickHouse别名列' },
  { label: 'DEFAULT', detail: 'ClickHouse默认值' },
  { label: 'CODEC', detail: 'ClickHouse编解码' },
  { label: 'PRIMARY KEY', detail: 'ClickHouse主键' },
  { label: 'ATTACH', detail: 'ClickHouse挂载表' },
  { label: 'DETACH', detail: 'ClickHouse卸载表' },
  { label: 'OPTIMIZE', detail: 'ClickHouse优化表' },
  { label: 'SYSTEM', detail: 'ClickHouse系统命令' },
  { label: 'QUOTA', detail: 'ClickHouse配额' },
  { label: 'ROW POLICY', detail: 'ClickHouse行策略' },
  { label: 'SETTINGS PROFILE', detail: 'ClickHouse配置模板' },
  { label: 'NAMED COLLECTION', detail: 'ClickHouse命名集合' },
  { label: 'KILL QUERY', detail: 'ClickHouse终止查询' },
  { label: 'KILL MUTATION', detail: 'ClickHouse终止变更' },
  { label: 'RENAME TABLE', detail: 'ClickHouse重命名表' },
  { label: 'EXCHANGE TABLES', detail: 'ClickHouse交换表名' },
  { label: 'FREEZE', detail: 'ClickHouse冻结分区' },
  { label: 'FETCH', detail: 'ClickHouse拉取分区' },
  { label: 'MOVE PARTITION', detail: 'ClickHouse移动分区' },
];

const SQL_FUNCTIONS = [
  { label: 'COUNT', detail: '计数', insertText: 'COUNT(${1:column})' },
  { label: 'SUM', detail: '求和', insertText: 'SUM(${1:column})' },
  { label: 'AVG', detail: '平均值', insertText: 'AVG(${1:column})' },
  { label: 'MAX', detail: '最大值', insertText: 'MAX(${1:column})' },
  { label: 'MIN', detail: '最小值', insertText: 'MIN(${1:column})' },
  { label: 'COALESCE', detail: '首个非空值', insertText: 'COALESCE(${1:val1}, ${2:val2})' },
  { label: 'NULLIF', detail: '相等返回NULL', insertText: 'NULLIF(${1:expr1}, ${2:expr2})' },
  { label: 'CONCAT', detail: '字符串拼接', insertText: 'CONCAT(${1:str1}, ${2:str2})' },
  { label: 'SUBSTRING', detail: '截取子串', insertText: 'SUBSTRING(${1:str}, ${2:pos}, ${3:len})' },
  { label: 'TRIM', detail: '去除首尾空格', insertText: 'TRIM(${1:str})' },
  { label: 'UPPER', detail: '转大写', insertText: 'UPPER(${1:str})' },
  { label: 'LOWER', detail: '转小写', insertText: 'LOWER(${1:str})' },
  { label: 'LENGTH', detail: '字符串长度', insertText: 'LENGTH(${1:str})' },
  { label: 'REPLACE', detail: '字符串替换', insertText: 'REPLACE(${1:str}, ${2:from}, ${3:to})' },
  { label: 'ROUND', detail: '四舍五入', insertText: 'ROUND(${1:num}, ${2:precision})' },
  { label: 'FLOOR', detail: '向下取整', insertText: 'FLOOR(${1:num})' },
  { label: 'CEIL', detail: '向上取整', insertText: 'CEIL(${1:num})' },
  { label: 'ABS', detail: '绝对值', insertText: 'ABS(${1:num})' },
  { label: 'NOW', detail: '当前时间', insertText: 'NOW()' },
  { label: 'CURRENT_DATE', detail: '当前日期', insertText: 'CURRENT_DATE' },
  { label: 'CURRENT_TIMESTAMP', detail: '当前时间戳', insertText: 'CURRENT_TIMESTAMP' },
  { label: 'DATE_FORMAT', detail: '日期格式化', insertText: 'DATE_FORMAT(${1:date}, ${2:pattern})' },
  { label: 'DATEDIFF', detail: '日期差', insertText: 'DATEDIFF(${1:date1}, ${2:date2})' },
  { label: 'ROW_NUMBER', detail: '行号', insertText: 'ROW_NUMBER() OVER(${1:ORDER BY})' },
  { label: 'RANK', detail: '排名(有间隙)', insertText: 'RANK() OVER(${1:ORDER BY})' },
  { label: 'DENSE_RANK', detail: '排名(无间隙)', insertText: 'DENSE_RANK() OVER(${1:ORDER BY})' },
  { label: 'LEAD', detail: '后N行值', insertText: 'LEAD(${1:column}, ${2:offset})' },
  { label: 'LAG', detail: '前N行值', insertText: 'LAG(${1:column}, ${2:offset})' },
  { label: 'FIRST_VALUE', detail: '首行值', insertText: 'FIRST_VALUE(${1:column}) OVER(${2:ORDER BY})' },
  { label: 'LAST_VALUE', detail: '末行值', insertText: 'LAST_VALUE(${1:column}) OVER(${2:ORDER BY})' },
  // ===== Hive 特有函数 =====
  { label: 'COLLECT_LIST', detail: 'Hive收集为数组', insertText: 'COLLECT_LIST(${1:column})' },
  { label: 'COLLECT_SET', detail: 'Hive收集去重数组', insertText: 'COLLECT_SET(${1:column})' },
  { label: 'GET_JSON_OBJECT', detail: 'Hive解析JSON', insertText: 'GET_JSON_OBJECT(${1:json_str}, ${2:path})' },
  { label: 'JSON_TUPLE', detail: 'Hive解析JSON多字段', insertText: 'JSON_TUPLE(${1:json_str}, ${2:key1}, ${3:key2})' },
  { label: 'PARSE_URL', detail: 'Hive解析URL', insertText: 'PARSE_URL(${1:url}, ${2:part})' },
  { label: 'REFLECT', detail: 'Hive反射调用', insertText: 'REFLECT(${1:class}, ${2:method}, ${3:args})' },
  { label: 'SPLIT', detail: 'Hive字符串分割', insertText: 'SPLIT(${1:str}, ${2:regex})' },
  { label: 'EXPLODE', detail: 'Hive炸裂数组', insertText: 'EXPLODE(${1:array_col})' },
  { label: 'POSEXPLODE', detail: 'Hive炸裂数组带索引', insertText: 'POSEXPLODE(${1:array_col})' },
  { label: 'INLINE', detail: 'Hive炸裂结构体数组', insertText: 'INLINE(${1:array_of_struct})' },
  { label: 'STACK', detail: 'Hive行转多行', insertText: 'STACK(${1:n}, ${2:val1}, ${3:val2})' },
  { label: 'MAP_KEYS', detail: 'Hive获取Map键', insertText: 'MAP_KEYS(${1:map_col})' },
  { label: 'MAP_VALUES', detail: 'Hive获取Map值', insertText: 'MAP_VALUES(${1:map_col})' },
  { label: 'ARRAY_CONTAINS', detail: 'Hive数组包含判断', insertText: 'ARRAY_CONTAINS(${1:array_col}, ${2:value})' },
  { label: 'SIZE', detail: 'Hive获取大小', insertText: 'SIZE(${1:col})' },
  { label: 'SORT_ARRAY', detail: 'Hive数组排序', insertText: 'SORT_ARRAY(${1:array_col})' },
  { label: 'ARRAY', detail: 'Hive构造数组', insertText: 'ARRAY(${1:val1}, ${2:val2})' },
  { label: 'MAP', detail: 'Hive构造Map', insertText: 'MAP(${1:key1}, ${2:val1})' },
  { label: 'STRUCT', detail: 'Hive构造结构体', insertText: 'STRUCT(${1:col1}, ${2:col2})' },
  { label: 'NAMED_STRUCT', detail: 'Hive命名结构体', insertText: 'NAMED_STRUCT(${1:name1}, ${2:val1})' },
  { label: 'LATERAL VIEW', detail: 'Hive侧视图', insertText: 'LATERAL VIEW ${1:func}(${2:col})' },
  { label: 'FROM_UNIXTIME', detail: 'Hive时间戳转日期', insertText: 'FROM_UNIXTIME(${1:ts}, ${2:pattern})' },
  { label: 'UNIX_TIMESTAMP', detail: 'Hive日期转时间戳', insertText: 'UNIX_TIMESTAMP(${1:date_str}, ${2:pattern})' },
  { label: 'TO_DATE', detail: 'Hive字符串转日期', insertText: 'TO_DATE(${1:date_str})' },
  { label: 'YEAR', detail: 'Hive提取年份', insertText: 'YEAR(${1:date})' },
  { label: 'MONTH', detail: 'Hive提取月份', insertText: 'MONTH(${1:date})' },
  { label: 'DAY', detail: 'Hive提取日', insertText: 'DAY(${1:date})' },
  { label: 'HOUR', detail: 'Hive提取小时', insertText: 'HOUR(${1:ts})' },
  { label: 'MINUTE', detail: 'Hive提取分钟', insertText: 'MINUTE(${1:ts})' },
  { label: 'SECOND', detail: 'Hive提取秒', insertText: 'SECOND(${1:ts})' },
  { label: 'DATE_ADD', detail: 'Hive日期加天数', insertText: 'DATE_ADD(${1:date}, ${2:days})' },
  { label: 'DATE_SUB', detail: 'Hive日期减天数', insertText: 'DATE_SUB(${1:date}, ${2:days})' },
  { label: 'ADD_MONTHS', detail: 'Hive日期加月份', insertText: 'ADD_MONTHS(${1:date}, ${2:months})' },
  { label: 'LAST_DAY', detail: 'Hive月末日期', insertText: 'LAST_DAY(${1:date})' },
  { label: 'NEXT_DAY', detail: 'Hive下个周几', insertText: 'NEXT_DAY(${1:date}, ${2:day_of_week})' },
  { label: 'TRUNC', detail: 'Hive日期截断', insertText: 'TRUNC(${1:date}, ${2:unit})' },
  { label: 'MONTHS_BETWEEN', detail: 'Hive月份差', insertText: 'MONTHS_BETWEEN(${1:date1}, ${2:date2})' },
  { label: 'NVL', detail: 'Hive空值替换', insertText: 'NVL(${1:expr}, ${2:default})' },
  { label: 'GROUPING', detail: 'Hive分组指示符', insertText: 'GROUPING(${1:column})' },
  { label: 'GROUPING__ID', detail: 'Hive分组ID', insertText: 'GROUPING__ID' },
  { label: 'PERCENTILE', detail: 'Hive百分位数', insertText: 'PERCENTILE(${1:col}, ${2:pct})' },
  { label: 'PERCENTILE_APPROX', detail: 'Hive近似百分位', insertText: 'PERCENTILE_APPROX(${1:col}, ${2:pct})' },
  // ===== Doris 特有函数 =====
  { label: 'BITMAP_COUNT', detail: 'Doris Bitmap计数', insertText: 'BITMAP_COUNT(${1:bitmap})' },
  { label: 'BITMAP_OR', detail: 'Doris Bitmap并集', insertText: 'BITMAP_OR(${1:b1}, ${2:b2})' },
  { label: 'BITMAP_AND', detail: 'Doris Bitmap交集', insertText: 'BITMAP_AND(${1:b1}, ${2:b2})' },
  { label: 'BITMAP_HASH', detail: 'Doris Bitmap哈希', insertText: 'BITMAP_HASH(${1:value})' },
  { label: 'BITMAP_TO_STRING', detail: 'Doris Bitmap转字符串', insertText: 'BITMAP_TO_STRING(${1:bitmap})' },
  { label: 'TO_BITMAP', detail: 'Doris转Bitmap', insertText: 'TO_BITMAP(${1:expr})' },
  { label: 'BITMAP_EMPTY', detail: 'Doris空Bitmap', insertText: 'BITMAP_EMPTY()' },
  { label: 'HLL_HASH', detail: 'Doris HLL哈希', insertText: 'HLL_HASH(${1:value})' },
  { label: 'HLL_CARDINALITY', detail: 'Doris HLL基数', insertText: 'HLL_CARDINALITY(${1:hll})' },
  { label: 'HLL_EMPTY', detail: 'Doris空HLL', insertText: 'HLL_EMPTY()' },
  { label: 'TOPN', detail: 'Doris TopN', insertText: 'TOPN(${1:n}, ${2:col})' },
  { label: 'ARRAY_AGG', detail: 'Doris数组聚合', insertText: 'ARRAY_AGG(${1:column})' },
  { label: 'REGEXP_EXTRACT', detail: 'Doris正则提取', insertText: 'REGEXP_EXTRACT(${1:str}, ${2:pattern}, ${3:idx})' },
  { label: 'REGEXP_REPLACE', detail: 'Doris正则替换', insertText: 'REGEXP_REPLACE(${1:str}, ${2:pattern}, ${3:repl})' },
  { label: 'JSON_EXTRACT', detail: 'Doris JSON提取', insertText: 'JSON_EXTRACT(${1:json}, ${2:path})' },
  { label: 'ELEMENT_AT', detail: 'Doris数组元素', insertText: 'ELEMENT_AT(${1:array}, ${2:index})' },
  { label: 'ARRAY_SORT', detail: 'Doris数组排序', insertText: 'ARRAY_SORT(${1:array})' },
  { label: 'ARRAY_DISTINCT', detail: 'Doris数组去重', insertText: 'ARRAY_DISTINCT(${1:array})' },
  { label: 'ARRAYS_OVERLAP', detail: 'Doris数组交集判断', insertText: 'ARRAYS_OVERLAP(${1:a1}, ${2:a2})' },
  { label: 'ARRAY_UNION', detail: 'Doris数组并集', insertText: 'ARRAY_UNION(${1:a1}, ${2:a2})' },
  { label: 'ARRAY_INTERSECT', detail: 'Doris数组交集', insertText: 'ARRAY_INTERSECT(${1:a1}, ${2:a2})' },
  { label: 'ARRAY_EXCEPT', detail: 'Doris数组差集', insertText: 'ARRAY_EXCEPT(${1:a1}, ${2:a2})' },
  { label: 'WINDOW_FUNNEL', detail: 'Doris漏斗分析', insertText: 'WINDOW_FUNNEL(${1:window}, ${2:mode}, ${3:ts_col}, ${4:cond1}, ${5:cond2})' },
  { label: 'RETENTION', detail: 'Doris留存分析', insertText: 'RETENTION(${1:cond1}, ${2:cond2})' },
  { label: 'SEQUENCE_COUNT', detail: 'Doris序列计数', insertText: 'SEQUENCE_COUNT(${1:pattern}, ${2:ts_col}, ${3:cond1}, ${4:cond2})' },
  { label: 'SEQUENCE_MATCH', detail: 'Doris序列匹配', insertText: 'SEQUENCE_MATCH(${1:pattern}, ${2:ts_col}, ${3:cond1}, ${4:cond2})' },
  // ===== ClickHouse 特有函数 =====
  { label: 'formatDateTime', detail: 'ClickHouse格式化日期', insertText: 'formatDateTime(${1:dt}, ${2:format})' },
  { label: 'toDate', detail: 'ClickHouse转日期', insertText: 'toDate(${1:expr})' },
  { label: 'toDateTime', detail: 'ClickHouse转时间', insertText: 'toDateTime(${1:expr})' },
  { label: 'toUnixTimestamp', detail: 'ClickHouse转时间戳', insertText: 'toUnixTimestamp(${1:dt})' },
  { label: 'toYYYYMM', detail: 'ClickHouse转年月', insertText: 'toYYYYMM(${1:dt})' },
  { label: 'toYYYYMMDD', detail: 'ClickHouse转年月日', insertText: 'toYYYYMMDD(${1:dt})' },
  { label: 'toStartOfDay', detail: 'ClickHouse当天开始', insertText: 'toStartOfDay(${1:dt})' },
  { label: 'toStartOfHour', detail: 'ClickHouse当时开始', insertText: 'toStartOfHour(${1:dt})' },
  { label: 'toStartOfMonth', detail: 'ClickHouse当月开始', insertText: 'toStartOfMonth(${1:dt})' },
  { label: 'toStartOfWeek', detail: 'ClickHouse当周开始', insertText: 'toStartOfWeek(${1:dt})' },
  { label: 'dateDiff', detail: 'ClickHouse日期差', insertText: 'dateDiff(${1:unit}, ${2:d1}, ${3:d2})' },
  { label: 'dateAdd', detail: 'ClickHouse日期加', insertText: 'dateAdd(${1:unit}, ${2:n}, ${3:dt})' },
  { label: 'dateSub', detail: 'ClickHouse日期减', insertText: 'dateSub(${1:unit}, ${2:n}, ${3:dt})' },
  { label: 'toString', detail: 'ClickHouse转字符串', insertText: 'toString(${1:expr})' },
  { label: 'toInt64', detail: 'ClickHouse转Int64', insertText: 'toInt64(${1:expr})' },
  { label: 'toFloat64', detail: 'ClickHouse转Float64', insertText: 'toFloat64(${1:expr})' },
  { label: 'toDecimal64', detail: 'ClickHouse转Decimal', insertText: 'toDecimal64(${1:expr}, ${2:scale})' },
  { label: 'arrayJoin', detail: 'ClickHouse数组展开', insertText: 'arrayJoin(${1:array_col})' },
  { label: 'arrayMap', detail: 'ClickHouse数组映射', insertText: 'arrayMap(${1:x}, ${2:array})' },
  { label: 'arrayFilter', detail: 'ClickHouse数组过滤', insertText: 'arrayFilter(${1:x}, ${2:array})' },
  { label: 'arrayExists', detail: 'ClickHouse数组存在判断', insertText: 'arrayExists(${1:x}, ${2:array})' },
  { label: 'arrayCount', detail: 'ClickHouse数组计数', insertText: 'arrayCount(${1:x}, ${2:array})' },
  { label: 'arrayReduce', detail: 'ClickHouse数组归约', insertText: 'arrayReduce(${1:agg_func}, ${2:array})' },
  { label: 'arraySort', detail: 'ClickHouse数组排序', insertText: 'arraySort(${1:func}, ${2:array})' },
  { label: 'arrayReverseSort', detail: 'ClickHouse数组逆序', insertText: 'arrayReverseSort(${1:func}, ${2:array})' },
  { label: 'arrayDistinct', detail: 'ClickHouse数组去重', insertText: 'arrayDistinct(${1:array})' },
  { label: 'arrayEnumerate', detail: 'ClickHouse数组索引', insertText: 'arrayEnumerate(${1:array})' },
  { label: 'arrayConcat', detail: 'ClickHouse数组拼接', insertText: 'arrayConcat(${1:a1}, ${2:a2})' },
  { label: 'arrayStringConcat', detail: 'ClickHouse数组连接字符串', insertText: 'arrayStringConcat(${1:array}, ${2:sep})' },
  { label: 'has', detail: 'ClickHouse包含判断', insertText: 'has(${1:array}, ${2:value})' },
  { label: 'hasAll', detail: 'ClickHouse全包含判断', insertText: 'hasAll(${1:array}, ${2:sub_array})' },
  { label: 'hasAny', detail: 'ClickHouse任意包含判断', insertText: 'hasAny(${1:array}, ${2:sub_array})' },
  { label: 'indexOf', detail: 'ClickHouse查找索引', insertText: 'indexOf(${1:array}, ${2:value})' },
  { label: 'countEqual', detail: 'ClickHouse计数相等', insertText: 'countEqual(${1:array}, ${2:value})' },
  { label: 'extractAll', detail: 'ClickHouse正则提取全部', insertText: 'extractAll(${1:str}, ${2:regex})' },
  { label: 'match', detail: 'ClickHouse正则匹配', insertText: 'match(${1:str}, ${2:pattern})' },
  { label: 'multiIf', detail: 'ClickHouse多条件判断', insertText: 'multiIf(${1:cond1}, ${2:val1}, ${3:cond2}, ${4:val2}, ${5:default})' },
  { label: 'quantile', detail: 'ClickHouse分位数', insertText: 'quantile(${1:level})(${2:col})' },
  { label: 'quantiles', detail: 'ClickHouse多分位数', insertText: 'quantiles(${1:l1}, ${2:l2})(${3:col})' },
  { label: 'quantileExact', detail: 'ClickHouse精确分位数', insertText: 'quantileExact(${1:level})(${2:col})' },
  { label: 'quantileTDigest', detail: 'ClickHouse TDigest分位数', insertText: 'quantileTDigest(${1:level})(${2:col})' },
  { label: 'uniq', detail: 'ClickHouse近似去重计数', insertText: 'uniq(${1:col})' },
  { label: 'uniqExact', detail: 'ClickHouse精确去重计数', insertText: 'uniqExact(${1:col})' },
  { label: 'uniqCombined', detail: 'ClickHouse组合去重计数', insertText: 'uniqCombined(${1:col})' },
  { label: 'groupArray', detail: 'ClickHouse分组收集数组', insertText: 'groupArray(${1:col})' },
  { label: 'groupUniqArray', detail: 'ClickHouse分组去重数组', insertText: 'groupUniqArray(${1:col})' },
  { label: 'groupArrayInsertAt', detail: 'ClickHouse分组插入数组', insertText: 'groupArrayInsertAt(${1:col})' },
  { label: 'topK', detail: 'ClickHouse TopK', insertText: 'topK(${1:n})(${2:col})' },
  { label: 'any', detail: 'ClickHouse任意值', insertText: 'any(${1:col})' },
  { label: 'anyLast', detail: 'ClickHouse最后任意值', insertText: 'anyLast(${1:col})' },
  { label: 'argMin', detail: 'ClickHouse最小参数', insertText: 'argMin(${1:val}, ${2:expr})' },
  { label: 'argMax', detail: 'ClickHouse最大参数', insertText: 'argMax(${1:val}, ${2:expr})' },
  { label: 'runningDifference', detail: 'ClickHouse相邻差值', insertText: 'runningDifference(${1:col})' },
  { label: 'runningAccumulate', detail: 'ClickHouse累积求和', insertText: 'runningAccumulate(${1:col})' },
  { label: 'neighbor', detail: 'ClickHouse相邻行', insertText: 'neighbor(${1:col}, ${2:offset})' },
  { label: 'visitParamExtractString', detail: 'ClickHouse提取JSON字符串', insertText: 'visitParamExtractString(${1:json}, ${2:key})' },
  { label: 'visitParamExtractInt', detail: 'ClickHouse提取JSON整数', insertText: 'visitParamExtractInt(${1:json}, ${2:key})' },
  { label: 'visitParamExtractFloat', detail: 'ClickHouse提取JSON浮点', insertText: 'visitParamExtractFloat(${1:json}, ${2:key})' },
  { label: 'visitParamHas', detail: 'ClickHouse JSON键存在', insertText: 'visitParamHas(${1:json}, ${2:key})' },
  { label: 'JSONExtractString', detail: 'ClickHouse JSON提取字符串', insertText: 'JSONExtractString(${1:json}, ${2:path})' },
  { label: 'JSONExtractInt', detail: 'ClickHouse JSON提取整数', insertText: 'JSONExtractInt(${1:json}, ${2:path})' },
  { label: 'JSONExtractFloat', detail: 'ClickHouse JSON提取浮点', insertText: 'JSONExtractFloat(${1:json}, ${2:path})' },
  { label: 'JSONHas', detail: 'ClickHouse JSON路径存在', insertText: 'JSONHas(${1:json}, ${2:path})' },
  { label: 'tuple', detail: 'ClickHouse构造元组', insertText: 'tuple(${1:val1}, ${2:val2})' },
  { label: 'untuple', detail: 'ClickHouse展开元组', insertText: 'untuple(${1:tuple})' },
  { label: 'tupleElement', detail: 'ClickHouse元组元素', insertText: 'tupleElement(${1:tuple}, ${2:index})' },
  { label: 'cityHash64', detail: 'ClickHouse CityHash64', insertText: 'cityHash64(${1:str})' },
  { label: 'sipHash64', detail: 'ClickHouse SipHash64', insertText: 'sipHash64(${1:str})' },
  { label: 'xxHash64', detail: 'ClickHouse xxHash64', insertText: 'xxHash64(${1:str})' },
  { label: 'URLHash', detail: 'ClickHouse URL哈希', insertText: 'URLHash(${1:url}, ${2:level})' },
  { label: 'halfMD5', detail: 'ClickHouse HalfMD5', insertText: 'halfMD5(${1:str})' },
  { label: 'MD5', detail: 'ClickHouse MD5', insertText: 'MD5(${1:str})' },
  { label: 'SHA256', detail: 'ClickHouse SHA256', insertText: 'SHA256(${1:str})' },
];

// FROM / JOIN 等关键字，后面应补全表名
const TABLE_TRIGGER_KEYWORDS = [
  'FROM', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN',
  'RIGHT JOIN', 'RIGHT OUTER JOIN', 'FULL JOIN', 'FULL OUTER JOIN',
  'CROSS JOIN', 'INTO', 'UPDATE', 'TABLE', 'DELETE FROM',
  'MERGE', 'REPLACE INTO',
];

// USE 后面应补全库名
const DATABASE_TRIGGER_KEYWORDS = ['USE'];

// SQL 中需要忽略的关键词（不作为标识符）
const SQL_RESERVED_WORDS = new Set([
  ...SQL_KEYWORDS.map(k => k.label.toLowerCase()),
  ...SQL_FUNCTIONS.map(f => f.label.toLowerCase()),
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group',
  'order', 'by', 'having', 'limit', 'offset', 'union', 'all', 'set',
  'insert', 'into', 'values', 'update', 'delete', 'create', 'alter',
  'drop', 'truncate', 'use', 'show', 'describe', 'desc', 'distinct',
  'case', 'when', 'then', 'else', 'end', 'cast', 'with', 'over',
  'partition', 'between', 'like', 'is', 'null', 'exists', 'true', 'false',
  'asc', 'desc', 'if', 'natural',
  'explain', 'commit', 'rollback', 'begin', 'grant', 'revoke',
  'any', 'some', 'recursive', 'qualify', 'merge', 'call', 'unnest',
  'add', 'column', 'constraint', 'foreign', 'references', 'check',
  'key', 'cascade', 'restrict', 'do', 'nothing', 'ilike', 'using',
  'replace', 'start', 'transaction',
]);

// ========== SQL 上下文解析 ==========

interface SqlContext {
  /** 当前正在输入的词 */
  word: string;
  /** 光标前的完整文本（当前行） */
  textBeforeCursor: string;
  /** 解析出的表别名映射：alias -> tableName */
  aliasMap: Record<string, string>;
  /** 触发类型 */
  triggerType: 'keyword' | 'database' | 'table' | 'column' | 'general';
  /** 如果是 column 类型，对应的表名或别名 */
  columnTableRef?: string;
}

/**
 * 从当前行的文本中提取 SQL 补全上下文
 * 支持的层级关系：
 *   USE <db>          → 数据库补全
 *   FROM <table>      → 表补全
 *   FROM <db>.<table> → 表补全（限定库）
 *   <table>.<col>     → 字段补全
 *   <alias>.<col>     → 字段补全（通过别名解析）
 */
function parseSqlContext(
  textBeforeCursor: string,
  currentWord: string,
  dataSources?: DataSource[],
  tables?: TableInfo[],
): SqlContext {
  // 保留尾部空格，否则 FROM 后的空格被 trimEnd() 去掉后无法匹配关键词正则
  const raw = textBeforeCursor;
  const upperRaw = raw.toUpperCase();

  // 检测是否在点号后（如 db.table 或 table.column）
  const lastDotIndex = raw.lastIndexOf('.');
  if (lastDotIndex >= 0 && lastDotIndex > raw.length - currentWord.length - 2) {
    const beforeDot = raw.substring(0, lastDotIndex).trim();
    const identifierAfterDot = beforeDot.split(/\s+/).pop()?.replace(/[,(`]/g, '') || '';

    // USE xxx. 模式 → 表补全
    if (upperRaw.match(/^USE\s+\S+\.\s*$/)) {
      return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap: {}, triggerType: 'table', columnTableRef: identifierAfterDot };
    }

    // 判断点号前是库名还是表名/别名
    if (dataSources && tables) {
      const knownDbNames = new Set<string>();
      for (const ds of dataSources) {
        if (ds.databaseName) ds.databaseName.forEach(n => knownDbNames.add(n.toLowerCase()));
      }
      for (const t of tables) {
        if (t.databaseName) knownDbNames.add(t.databaseName.toLowerCase());
      }

      if (knownDbNames.has(identifierAfterDot.toLowerCase())) {
        return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap: {}, triggerType: 'table', columnTableRef: identifierAfterDot };
      }
    }

    return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap: {}, triggerType: 'column', columnTableRef: identifierAfterDot };
  }

  const aliasMap = extractAliasMap(raw);

  for (const kw of DATABASE_TRIGGER_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\s+(\\w*)$`, 'i');
    if (raw.match(regex) && !currentWord) {
      return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap, triggerType: 'database' };
    }
  }

  for (const kw of TABLE_TRIGGER_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\s+(?:\\w+\\.)?(\\w*)$`, 'i');
    const match = raw.match(regex);
    if (match) {
      const afterKw = raw.replace(new RegExp(`.*\\b${kw}\\s+`, 'i'), '');
      if (/^\w+\s+AS\s*$/i.test(afterKw) || /^\w+\s+\w+$/i.test(afterKw)) {
        continue;
      }
      return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap, triggerType: 'table' };
    }
  }

  // 判断光标当前处于哪个 SQL 子句：找到最后一个子句起始关键词的位置
  const clauseKeywords = [
    /\bSELECT\b/gi, /\bFROM\b/gi, /\bWHERE\b/gi, /\bGROUP\s+BY\b/gi,
    /\bHAVING\b/gi, /\bORDER\s+BY\b/gi, /\bLIMIT\b/gi,
    /\bJOIN\b/gi, /\bLEFT\s+JOIN\b/gi, /\bRIGHT\s+JOIN\b/gi,
    /\bINNER\s+JOIN\b/gi, /\bCROSS\s+JOIN\b/gi, /\bFULL\s+JOIN\b/gi,
    /\bON\b/gi, /\bSET\b/gi, /\bINTO\b/gi, /\bVALUES\b/gi,
  ];
  let lastClauseIndex = -1;
  let lastClauseKeyword = '';
  for (const kwRegex of clauseKeywords) {
    kwRegex.lastIndex = 0;
    let m;
    while ((m = kwRegex.exec(raw)) !== null) {
      if (m.index > lastClauseIndex) {
        lastClauseIndex = m.index;
        lastClauseKeyword = m[0].toUpperCase().replace(/\s+/g, ' ');
      }
    }
  }

  // 光标在 SELECT 子句中 → 字段补全
  if (lastClauseKeyword === 'SELECT') {
    return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap, triggerType: 'column' };
  }

  // 光标在 WHERE / ON / HAVING / GROUP BY / ORDER BY 子句中 → 字段补全
  if (['WHERE', 'ON', 'HAVING', 'GROUP BY', 'ORDER BY'].includes(lastClauseKeyword)) {
    return { word: currentWord, textBeforeCursor: raw.trimEnd(), aliasMap, triggerType: 'column' };
  }

  return {
    word: currentWord,
    textBeforeCursor: raw.trimEnd(),
    aliasMap,
    triggerType: 'general',
  };
}

/**
 * 从 SQL 文本中提取表别名映射
 * 支持: FROM table_name AS alias, FROM table_name alias, JOIN table_name alias
 */
function extractAliasMap(sqlText: string): Record<string, string> {
  const aliasMap: Record<string, string> = {};

  // 匹配 FROM/JOIN + 表名 [+ AS] + 别名 的模式
  const patterns = [
    /(?:FROM|JOIN)\s+(\w+(?:\.\w+)?)\s+(?:AS\s+)?(\w+)\s*(?:,|WHERE|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|GROUP|ORDER|HAVING|ON|$)/gi,
    /(?:FROM|JOIN)\s+(\w+(?:\.\w+)?)\s+(?:AS\s+)?(\w+)\s*,/gi,
  ];

  for (const pattern of patterns) {
    let match;
    pattern.lastIndex = 0; // 重置正则状态
    while ((match = pattern.exec(sqlText)) !== null) {
      const tableName = match[1].includes('.') ? match[1].split('.')[1] : match[1];
      const alias = match[2];
      // 确保别名不是 SQL 保留字
      if (!SQL_RESERVED_WORDS.has(alias.toLowerCase())) {
        aliasMap[alias] = tableName;
      }
    }
  }

  return aliasMap;
}

/**
 * 根据别名或表名查找对应表的字段信息
 */
function findColumnsByTableRef(
  tableRef: string,
  aliasMap: Record<string, string>,
  tables: TableInfo[],
): TableInfo['columns'] | null {
  // 先尝试通过别名查找真实表名
  const realTableName = aliasMap[tableRef] || tableRef;

  // 不区分大小写匹配
  const table = tables.find(
    t => t.tableName.toLowerCase() === realTableName.toLowerCase()
  );

  if (table?.columns?.length) return table.columns;

  return null;
}

// ========== Hook 主逻辑 ==========

export interface UseSqlCompletionParams {
  dataSources: DataSource[];
  tables: TableInfo[];
  /** 当前用户 ID，用于字段缓存隔离 */
  userId?: number | null;
  /** 字段按需加载完成后的回调，用于回写到上下文 */
  onColumnsLoaded?: (databaseName: string, tableName: string, columns: ColumnInfo[]) => void;
}

export function useSqlCompletion(params?: UseSqlCompletionParams) {
  const completionProviderRef = useRef<any>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // 按需加载某个表的字段信息（用户触发字段补全时才请求）
  const fetchColumnsIfNeeded = useCallback((table: TableInfo) => {
    // 表自身已携带字段信息，无需再请求
    if (table.columns?.length) return;

    const onColumnsLoaded = paramsRef.current?.onColumnsLoaded;

    fetchTableColumns(
      table.storageEngine || '',
      table.databaseName || '',
      table.tableName,
    ).then(res => {
      if (res.code === 200 && Array.isArray(res.data)) {
        const columns: ColumnInfo[] = res.data;
        // 通过回调将字段信息回写到上下文
        if (onColumnsLoaded && columns.length > 0) {
          onColumnsLoaded(table.databaseName || '', table.tableName, columns);
        }
      }
    }).catch(() => {
      // 加载失败，静默处理
    });
  }, []);

  const setupSQLCompletion = useCallback((monacoInstance: any) => {
    if (completionProviderRef.current) {
      completionProviderRef.current.dispose();
      completionProviderRef.current = null;
    }

    if (!monacoInstance) return;

    completionProviderRef.current = monacoInstance.languages.registerCompletionItemProvider('sql', {
      // 触发字符不含空格：空格曾被登记为触发字符，导致在编辑器内按空格时补全弹窗
      // 被触发/抢占，表现为「无法输入空格」。保留 . 与 , 即可覆盖库名/字段补全场景；
      // 输入过程中仍有 quickSuggestions 兜底，不影响正常补全。
      triggerCharacters: ['.', ','],
      provideCompletionItems: (model: any, position: any) => {
        const { dataSources = [], tables = [] } = paramsRef.current || {};
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        const currentWord = word.word || '';

        // 考虑前几行的上下文（用于提取别名映射）
        const startLine = Math.max(1, position.lineNumber - 20);
        const multiLineContext = model.getValueInRange({
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: word.startColumn,
        });

        const ctx = parseSqlContext(multiLineContext, currentWord, dataSources, tables);
        const suggestions: any[] = [];

        // ===== 1. 根据上下文提供特定层级的建议 =====

        if (ctx.triggerType === 'database') {
          // 库名补全
          pushDatabaseSuggestions(suggestions, dataSources, tables, monacoInstance, range);
        } else if (ctx.triggerType === 'table') {
          // 表名补全
          if (ctx.columnTableRef) {
            // 库名. 模式 → 只显示该库下的表，不显示库名列表
            const filteredTables = tables.filter(t =>
              t.databaseName?.toLowerCase() === ctx.columnTableRef!.toLowerCase()
            );
            pushTableSuggestions(suggestions, filteredTables, monacoInstance, range);
          } else {
            // FROM/JOIN 等关键词后 → 同时显示库名和表名
            pushDatabaseSuggestions(suggestions, dataSources, tables, monacoInstance, range);
            pushTableSuggestions(suggestions, tables, monacoInstance, range);
          }
        } else if (ctx.triggerType === 'column') {
          // 字段补全（按需加载字段信息）
          pushColumnSuggestions(
            suggestions, ctx.columnTableRef, ctx.aliasMap, tables,
            monacoInstance, range, fetchColumnsIfNeeded
          );
        }

        // ===== 2. 始终提供关键词和函数建议 =====
        pushKeywordSuggestions(suggestions, monacoInstance, range);
        pushFunctionSuggestions(suggestions, monacoInstance, range);

        // ===== 3. 按 label 去重（大小写不敏感，优先保留先出现的） =====
        const seen = new Set<string>();
        const deduped = suggestions.filter(item => {
          const key = (item.label || '').toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        return { suggestions: deduped };
      },
    });
  }, []);

  const disposeCompletion = useCallback(() => {
    if (completionProviderRef.current) {
      completionProviderRef.current.dispose();
      completionProviderRef.current = null;
    }
  }, []);

  return { setupSQLCompletion, disposeCompletion };
}

// ========== 各层级补全建议生成函数 ==========

function pushDatabaseSuggestions(
  suggestions: any[],
  dataSources: DataSource[],
  tables: TableInfo[],
  monaco: any,
  range: any,
) {
  const dbNames = new Set<string>();
  // 从 dataSources 提取
  for (const ds of dataSources) {
    if (ds.databaseName) {
      for (const name of ds.databaseName) { dbNames.add(name); }
    }
  }
  // 从 tables 的 databaseName 字段补充提取
  for (const t of tables) {
    if (t.databaseName) { dbNames.add(t.databaseName); }
  }

  Array.from(dbNames).sort().forEach((name, i) => {
    suggestions.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Module,
      insertText: name,
      detail: '数据库',
      documentation: `数据库: ${name}`,
      range,
      sortText: 'a' + String(i).padStart(3, '0'),
    });
  });
}

function pushTableSuggestions(
  suggestions: any[],
  tables: TableInfo[],
  monaco: any,
  range: any,
) {
  const seen = new Set<string>();
  tables.forEach((table, i) => {
    const key = table.tableName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const colCount = table.columns?.length || 0;
    suggestions.push({
      label: table.tableName,
      kind: monaco.languages.CompletionItemKind.Class,
      insertText: table.tableName,
      detail: table.tableComment || (colCount > 0 ? `${colCount} 列` : '数据表'),
      documentation: formatTableDoc(table),
      range,
      sortText: 'b' + String(i).padStart(3, '0'),
    });
  });
}

function pushColumnSuggestions(
  suggestions: any[],
  columnTableRef: string | undefined,
  aliasMap: Record<string, string>,
  tables: TableInfo[],
  monaco: any,
  range: any,
  fetchColumnsIfNeeded: (table: TableInfo) => void,
) {
  let columns: TableInfo['columns'] | null = null;

  if (columnTableRef) {
    // 有明确的表引用（表名或别名）→ 只显示该表的字段
    columns = findColumnsByTableRef(columnTableRef, aliasMap, tables);

    if (!columns) {
      // 按需加载：找到对应表但缺少字段信息，触发请求（下次补全时即可使用）
      const realTableName = aliasMap[columnTableRef] || columnTableRef;
      const table = tables.find(t => t.tableName.toLowerCase() === realTableName.toLowerCase());
      if (table) fetchColumnsIfNeeded(table);
    }

    if (columns) {
      const sourceLabel = aliasMap[columnTableRef]
        ? `${aliasMap[columnTableRef]} (alias: ${columnTableRef})`
        : columnTableRef;
      const seen = new Set<string>();
      columns.forEach((col, i) => {
        const key = col.columnName.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        suggestions.push({
          label: col.columnName,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: col.columnName,
          detail: `${col.columnType || ''}${col.columnComment ? ' — ' + col.columnComment : ''}`,
          documentation: formatColumnDoc(col, sourceLabel),
          range,
          sortText: 'c' + String(i).padStart(3, '0'),
        });
      });
    }
  } else {
    // 无明确表引用 → 显示所有已知表的字段（带表名前缀避免歧义）
    const seen = new Set<string>();
    tables.forEach(table => {
      const cols = table.columns?.length ? table.columns : null;
      if (!cols) {
        // 按需加载
        fetchColumnsIfNeeded(table);
        return;
      }
      cols.forEach(col => {
        const key = col.columnName.toLowerCase();
        if (seen.has(key)) return; // 去重（大小写不敏感）
        seen.add(key);
        suggestions.push({
          label: col.columnName,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: col.columnName,
          detail: `${col.columnType || ''}${col.columnComment ? ' — ' + col.columnComment : ''} (${table.tableName})`,
          documentation: formatColumnDoc(col, table.tableName),
          range,
          sortText: 'c' + String(suggestions.filter(s => s.sortText?.startsWith('c')).length).padStart(3, '0'),
        });
      });
    });
  }
}

function pushKeywordSuggestions(
  suggestions: any[],
  monaco: any,
  range: any,
) {
  SQL_KEYWORDS.forEach((kw, i) => {
    suggestions.push({
      label: kw.label,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw.label,
      detail: kw.detail,
      range,
      sortText: 'z1' + String(i).padStart(3, '0'),
    });
  });
}

function pushFunctionSuggestions(
  suggestions: any[],
  monaco: any,
  range: any,
) {
  SQL_FUNCTIONS.forEach((fn, i) => {
    suggestions.push({
      label: fn.label,
      kind: monaco.languages.CompletionItemKind.Function,
      insertText: fn.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: fn.detail,
      range,
      sortText: 'z2' + String(i).padStart(3, '0'),
    });
  });
}

// ========== 格式化文档辅助函数 ==========

function formatTableDoc(table: TableInfo): string {
  const parts: string[] = [`**${table.tableName}**`];
  if (table.tableComment) parts.push(table.tableComment);
  if (table.databaseName) parts.push(`数据库: ${table.databaseName}`);
  if (table.columns && table.columns.length > 0) {
    parts.push('\n**字段:**');
    table.columns.forEach(col => {
      const pk = col.isPrimaryKey ? ' [PK]' : '';
      const part = col.isPartition ? ' [分区]' : '';
      parts.push(`  - \`${col.columnName}\`${pk}${part} — ${col.columnType || '?'}`);
    });
  }
  return parts.join('\n');
}

function formatColumnDoc(col: { columnName: string; columnType?: string; columnComment?: string; isPrimaryKey?: number; isPartition?: number }, sourceTable: string): string {
  const parts: string[] = [`**${col.columnName}**`];
  parts.push(`来源: ${sourceTable}`);
  if (col.columnType) parts.push(`类型: ${col.columnType}`);
  if (col.columnComment) parts.push(`注释: ${col.columnComment}`);
  if (col.isPrimaryKey) parts.push('主键: 是');
  if (col.isPartition) parts.push('分区列: 是');
  return parts.join('\n');
}
