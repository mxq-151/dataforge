package com.dataforge

import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.SaveMode

/**
 * Spark 3.5.9 / Scala 2.12.21 demo 程序。
 * 用于验证 METALS 构建的 LSP 服务稳定性：悬停 SparkSession 时，
 * 冷启动只会返回 "object org.apache.spark.sql.SparkSession" 类型签名，
 * 就绪后应返回含下列文档的完整内容（以 "The entry point to programming" 开头）。
 */
object SparkDemo {

  def main(args: Array[String]): Unit = {
    // 悬停目标：SparkSession（成功标记对象）
    val spark: SparkSession = SparkSession.builder()
      .master("local[*]")
      .appName("SparkDemo")
      .getOrCreate()

    import spark.implicits._

    val df = Seq((1, "a"), (2, "b")).toDF("id", "name")
    df.write
      .mode(SaveMode.Overwrite)
      .parquet("target/out")

    spark.stop()
  }
}