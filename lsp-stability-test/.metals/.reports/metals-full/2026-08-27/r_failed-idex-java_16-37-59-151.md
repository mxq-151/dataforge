error id: jar:file://<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/UnionMapWriter.java
file://<WORKSPACE>/jar:file:<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/UnionMapWriter.java
### java.lang.Exception: Unexpected symbol '#' at word pos: '35' Line: '  <#list  vv.types as type><#list type.minor as minor><#assign name = minor.class?cap_first />'

Java indexer failed with and exception.
```Java
/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import org.apache.arrow.memory.ArrowBuf;
import org.apache.arrow.vector.complex.writer.Decimal256Writer;
import org.apache.arrow.vector.complex.writer.DecimalWriter;
import org.apache.arrow.vector.holders.Decimal256Holder;
import org.apache.arrow.vector.holders.DecimalHolder;

import java.lang.UnsupportedOperationException;
import java.math.BigDecimal;

<@pp.dropOutputFile />
<@pp.changeOutputFile name="/org/apache/arrow/vector/complex/impl/UnionMapWriter.java" />


<#include "/@includes/license.ftl" />

package org.apache.arrow.vector.complex.impl;

<#include "/@includes/vv_imports.ftl" />

/*
 * This class is generated using freemarker and the ${.template_name} template.
 */

/**
 * <p>Writer for MapVectors. This extends UnionListWriter to simplify writing map entries to a list
 * of struct elements, with "key" and "value" fields. The procedure for writing a map begin with
 * {@link #startMap()} followed by {@link #startEntry()}. An entry is written by using the
 * {@link #key()} writer to write the key, then the {@link #value()} writer to write a value. After
 * writing the value, call {@link #endEntry()} to complete the entry. Each map can have 1 or more
 * entries. When done writing entries, call {@link #endMap()} to complete the map.
 *
 * <p>NOTE: the MapVector can have NULL values by not writing to position. If a map is started with
 * {@link #startMap()}, then it must have a key written. The value of a map entry can be NULL by
 * not using the {@link #value()} writer.
 *
 * <p>Example to write the following map to position 5 of a vector
 * <pre>{@code
 *   // {
 *   //   1 -> 3,
 *   //   2 -> 4,
 *   //   3 -> NULL
 *   // }
 *
 *   UnionMapWriter writer = ...
 *
 *   writer.setPosition(5);
 *   writer.startMap();
 *   writer.startEntry();
 *   writer.key().integer().writeInt(1);
 *   writer.value().integer().writeInt(3);
 *   writer.endEntry();
 *   writer.startEntry();
 *   writer.key().integer().writeInt(2);
 *   writer.value().integer().writeInt(4);
 *   writer.endEntry();
 *   writer.startEntry();
 *   writer.key().integer().writeInt(3);
 *   writer.endEntry();
 *   writer.endMap();
 * </pre>
 * </p>
 */
@SuppressWarnings("unused")
public class UnionMapWriter extends UnionListWriter {

  /**
   * Current mode for writing map entries, set by calling {@link #key()} or {@link #value()}
   * and reset with a call to {@link #endEntry()}. With KEY mode, a struct writer with field
   * named "key" is returned. With VALUE mode, a struct writer with field named "value" is
   * returned. In OFF mode, the writer will behave like a standard UnionListWriter
   */
  private enum MapWriteMode {
    OFF,
    KEY,
    VALUE,
  }

  private MapWriteMode mode = MapWriteMode.OFF;
  private StructWriter entryWriter;

  public UnionMapWriter(MapVector vector) {
    super(vector);
    entryWriter = struct();
  }

  /** Start writing a map that consists of 1 or more entries. */
  public void startMap() {
    startList();
  }

  /** Complete the map. */
  public void endMap() {
    endList();
  }

  /**
   * Start a map entry that should be followed by calls to {@link #key()} and {@link #value()}
   * writers. Call {@link #endEntry()} to complete the entry.
   */
  public void startEntry() {
    writer.setAddVectorAsNullable(false);
    entryWriter.start();
  }

  /** Complete the map entry. */
  public void endEntry() {
    entryWriter.end();
    mode = MapWriteMode.OFF;
    writer.setAddVectorAsNullable(true);
  }

  /** Return the key writer that is used to write to the "key" field. */
  public UnionMapWriter key() {
    writer.setAddVectorAsNullable(false);
    mode = MapWriteMode.KEY;
    return this;
  }

  /** Return the value writer that is used to write to the "value" field. */
  public UnionMapWriter value() {
    writer.setAddVectorAsNullable(true);
    mode = MapWriteMode.VALUE;
    return this;
  }

  <#list vv.types as type><#list type.minor as minor><#assign name = minor.class?cap_first />
  <#assign fields = minor.fields!type.fields />
  <#assign uncappedName = name?uncap_first/>
  <#if uncappedName == "int" ><#assign uncappedName = "integer" /></#if>
  <#if !minor.typeParams?? >
  @Override
  public ${name}Writer ${uncappedName}() {
    switch (mode) {
      case KEY:
        return entryWriter.${uncappedName}(MapVector.KEY_NAME);
      case VALUE:
        return entryWriter.${uncappedName}(MapVector.VALUE_NAME);
      default:
        return this;
    }
  }

  </#if>
  </#list></#list>
  @Override
  public DecimalWriter decimal() {
    switch (mode) {
      case KEY:
        return entryWriter.decimal(MapVector.KEY_NAME);
      case VALUE:
        return entryWriter.decimal(MapVector.VALUE_NAME);
      default:
        return this;
    }
  }

  @Override
  public Decimal256Writer decimal256() {
    switch (mode) {
      case KEY:
        return entryWriter.decimal256(MapVector.KEY_NAME);
      case VALUE:
        return entryWriter.decimal256(MapVector.VALUE_NAME);
      default:
        return this;
    }
  }


  @Override
  public StructWriter struct() {
    switch (mode) {
      case KEY:
        return entryWriter.struct(MapVector.KEY_NAME);
      case VALUE:
        return entryWriter.struct(MapVector.VALUE_NAME);
      default:
        return super.struct();
    }
  }

  @Override
  public ListWriter list() {
    switch (mode) {
      case KEY:
        return entryWriter.list(MapVector.KEY_NAME);
      case VALUE:
        return entryWriter.list(MapVector.VALUE_NAME);
      default:
        return super.list();
    }
  }

  @Override
  public MapWriter map(boolean keysSorted) {
    switch (mode) {
      case KEY:
        return entryWriter.map(MapVector.KEY_NAME, keysSorted);
      case VALUE:
        return entryWriter.map(MapVector.VALUE_NAME, keysSorted);
      default:
        return super.map();
    }
  }
}

```


#### Error stacktrace:

```
scala.meta.internal.mtags.JavaToplevelMtags.unexpectedCharacter(JavaToplevelMtags.scala:354)
	scala.meta.internal.mtags.JavaToplevelMtags.parseToken$1(JavaToplevelMtags.scala:255)
	scala.meta.internal.mtags.JavaToplevelMtags.fetchToken(JavaToplevelMtags.scala:264)
	scala.meta.internal.mtags.JavaToplevelMtags.loop(JavaToplevelMtags.scala:75)
	scala.meta.internal.mtags.JavaToplevelMtags.indexRoot(JavaToplevelMtags.scala:43)
	scala.meta.internal.mtags.MtagsIndexer.index(MtagsIndexer.scala:22)
	scala.meta.internal.mtags.MtagsIndexer.index$(MtagsIndexer.scala:21)
	scala.meta.internal.mtags.JavaToplevelMtags.index(JavaToplevelMtags.scala:18)
	scala.meta.internal.mtags.Mtags.extendedIndexing(Mtags.scala:78)
	scala.meta.internal.mtags.SymbolIndexBucket.indexSource(SymbolIndexBucket.scala:133)
	scala.meta.internal.mtags.SymbolIndexBucket.addSourceFile(SymbolIndexBucket.scala:109)
	scala.meta.internal.mtags.SymbolIndexBucket.$anonfun$addSourceJar$2(SymbolIndexBucket.scala:75)
	scala.collection.immutable.List.flatMap(List.scala:283)
	scala.meta.internal.mtags.SymbolIndexBucket.$anonfun$addSourceJar$1(SymbolIndexBucket.scala:71)
	scala.meta.internal.io.PlatformFileIO$.withJarFileSystem(PlatformFileIO.scala:75)
	scala.meta.internal.io.FileIO$.withJarFileSystem(FileIO.scala:33)
	scala.meta.internal.mtags.SymbolIndexBucket.addSourceJar(SymbolIndexBucket.scala:69)
	scala.meta.internal.mtags.OnDemandSymbolIndex.$anonfun$addSourceJar$2(OnDemandSymbolIndex.scala:86)
	scala.meta.internal.mtags.OnDemandSymbolIndex.tryRun(OnDemandSymbolIndex.scala:132)
	scala.meta.internal.mtags.OnDemandSymbolIndex.addSourceJar(OnDemandSymbolIndex.scala:85)
	scala.meta.internal.metals.Indexer.indexJar(Indexer.scala:662)
	scala.meta.internal.metals.Indexer.addSourceJarSymbols(Indexer.scala:647)
	scala.meta.internal.metals.Indexer.processDependencyPath(Indexer.scala:394)
	scala.meta.internal.metals.Indexer.$anonfun$indexDependencyModules$9(Indexer.scala:454)
	scala.meta.internal.metals.Indexer.$anonfun$indexDependencyModules$9$adapted(Indexer.scala:426)
	scala.collection.IterableOnceOps.foreach(IterableOnce.scala:630)
	scala.collection.IterableOnceOps.foreach$(IterableOnce.scala:628)
	scala.collection.AbstractIterable.foreach(Iterable.scala:936)
	scala.collection.IterableOps$WithFilter.foreach(Iterable.scala:906)
	scala.meta.internal.metals.Indexer.$anonfun$indexDependencyModules$3(Indexer.scala:426)
	scala.meta.internal.metals.Indexer.$anonfun$indexDependencyModules$3$adapted(Indexer.scala:424)
	scala.collection.IterableOnceOps.foreach(IterableOnce.scala:630)
	scala.collection.IterableOnceOps.foreach$(IterableOnce.scala:628)
	scala.collection.AbstractIterable.foreach(Iterable.scala:936)
	scala.collection.IterableOps$WithFilter.foreach(Iterable.scala:906)
	scala.meta.internal.metals.Indexer.$anonfun$indexDependencyModules$1(Indexer.scala:424)
	scala.meta.internal.metals.Indexer.$anonfun$indexDependencyModules$1$adapted(Indexer.scala:423)
	scala.collection.IterableOnceOps.foreach(IterableOnce.scala:630)
	scala.collection.IterableOnceOps.foreach$(IterableOnce.scala:628)
	scala.collection.AbstractIterable.foreach(Iterable.scala:936)
	scala.meta.internal.metals.Indexer.indexDependencyModules(Indexer.scala:423)
	scala.meta.internal.metals.Indexer.$anonfun$indexWorkspace$20(Indexer.scala:199)
	scala.runtime.java8.JFunction0$mcV$sp.apply(JFunction0$mcV$sp.scala:18)
	scala.meta.internal.metals.TimerProvider.timedThunk(TimerProvider.scala:25)
	scala.meta.internal.metals.Indexer.$anonfun$indexWorkspace$19(Indexer.scala:192)
	scala.meta.internal.metals.Indexer.$anonfun$indexWorkspace$19$adapted(Indexer.scala:188)
	scala.collection.immutable.List.foreach(List.scala:323)
	scala.meta.internal.metals.Indexer.indexWorkspace(Indexer.scala:188)
	scala.meta.internal.metals.Indexer.$anonfun$profiledIndexWorkspace$2(Indexer.scala:58)
	scala.runtime.java8.JFunction0$mcV$sp.apply(JFunction0$mcV$sp.scala:18)
	scala.meta.internal.metals.TimerProvider.timedThunk(TimerProvider.scala:25)
	scala.meta.internal.metals.Indexer.$anonfun$profiledIndexWorkspace$1(Indexer.scala:58)
	scala.runtime.java8.JFunction0$mcV$sp.apply(JFunction0$mcV$sp.scala:18)
	scala.concurrent.Future$.$anonfun$apply$1(Future.scala:691)
	scala.concurrent.impl.Promise$Transformation.run(Promise.scala:500)
	java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)
	java.base/java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:635)
	java.base/java.lang.Thread.run(Thread.java:840)
```
#### Short summary: 

Java indexer failed with and exception.