/**
 * JDT.LS `jdt://` 类文件 URI 的解析工具。
 *
 * JDT.LS 对「定义跳转」到 JDK / 第三方库的类，返回的 Location URI 形如：
 *   jdt://contents/spark-sql_2.12-3.5.9.jar/org.apache.spark.sql/SparkSession.class?=myproj
 *   jdt://contents/java.base/java.lang/String.class?=...
 *
 * 结构：
 *   jdt://contents/{jarName}/{包路径}/{类名}.class?{query}
 *
 * 其中：
 *   - jarName：二进制 jar 文件名（如 `spark-sql_2.12-3.5.9.jar`）；JDK 模块为 `java.base` 等（无 .jar 后缀）。
 *   - 类名：全限定名（用 `.` 分隔），如 `org.apache.spark.sql.SparkSession`。
 *
 * 用途：当 jarName 是 .jar（第三方库）时，我们可以据此在本地 ~/.m2/repository 里
 * 定位到对应的 `-sources.jar`，并读取其中的 `.scala` 源码——从而绕开 JDT.LS 对
 * Scala 库「只反编译 .class、读不到 .scala 源码」的固有限制。
 */

export interface JdtClassUri {
  /** 二进制 jar 文件名（可能不含路径），如 `spark-sql_2.12-3.5.9.jar` */
  jarName: string;
  /** 全限定类名（用 `.` 分隔），如 `org.apache.spark.sql.SparkSession` */
  className: string;
  /** jarName 是否以 `.jar` 结尾（false 表示 JDK 模块等非 jar 目标，无 sources jar 可查） */
  isJar: boolean;
}

/**
 * 解析 jdt:// 类文件 URI。
 * @returns 解析成功返回结构化信息；非 jdt: scheme 或格式异常返回 null。
 */
export function parseJdtClassUri(uri: string): JdtClassUri | null {
  if (!uri || !uri.startsWith('jdt:')) return null;

  // 去掉 query（? 及其后）
  const withoutQuery = uri.split('?')[0];
  const prefix = 'jdt://contents/';
  if (!withoutQuery.startsWith(prefix)) return null;

  const rest = withoutQuery.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // 无 jarName 或 jarName 为空

  const jarName = rest.slice(0, slash);
  // 类路径：org/apache/spark/sql/SparkSession.class → org.apache.spark.sql.SparkSession
  const classPath = rest.slice(slash + 1);
  if (!classPath) return null;

  const className = classPath.replace(/\.class$/i, '').replace(/\//g, '.');
  if (!className) return null;

  return { jarName, className, isJar: jarName.toLowerCase().endsWith('.jar') };
}

/**
 * 由 jdt:// URI 推导「类名 → sources jar 内部 .scala 路径」。
 *
 * Scala 顶层类/对象的源文件名 = 类名 + `.scala`（如 SparkSession → SparkSession.scala）。
 * 内部类（如 Dataset$RowEncoder）的源码在外部类的文件里，故取 `$` 之前的顶层类名。
 *
 * @returns sources jar 内的相对路径（如 `org/apache/spark/sql/SparkSession.scala`），
 *          类名为空时返回 null。
 */
export function classNameToScalaPath(className: string): string | null {
  if (!className) return null;
  // 内部类/匿名类取顶层类名；再按包路径 + `.scala` 拼出 jar 内相对路径
  const topClass = className.split('$')[0];
  return topClass.replace(/\./g, '/') + '.scala';
}
