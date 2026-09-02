package demo;

import org.apache.spark.SparkConf;
import com.google.common.base.Preconditions;

public class SparkDemo {
    SparkConf conf = new SparkConf();
    void g() { Preconditions.checkNotNull(conf); }
}