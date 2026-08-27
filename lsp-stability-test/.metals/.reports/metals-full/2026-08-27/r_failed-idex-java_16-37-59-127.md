error id: jar:file://<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/AbstractPromotableFieldWriter.java
file://<WORKSPACE>/jar:file:<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/AbstractPromotableFieldWriter.java
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

<@pp.dropOutputFile />
<@pp.changeOutputFile name="/org/apache/arrow/vector/complex/impl/AbstractPromotableFieldWriter.java" />


<#include "/@includes/license.ftl" />

package org.apache.arrow.vector.complex.impl;

<#include "/@includes/vv_imports.ftl" />

/*
 * A FieldWriter which delegates calls to another FieldWriter. The delegate FieldWriter can be promoted to a new type
 * when necessary. Classes that extend this class are responsible for handling promotion.
 *
 * This class is generated using freemarker and the ${.template_name} template.
 *
 */
@SuppressWarnings("unused")
abstract class AbstractPromotableFieldWriter extends AbstractFieldWriter {
  /**
   * Retrieve the FieldWriter, promoting if it is not a FieldWriter of the specified type
   * @param type the type of the values we want to write
   * @return the corresponding field writer
   */
  protected FieldWriter getWriter(MinorType type) {
    return getWriter(type, null);
  }

  abstract protected FieldWriter getWriter(MinorType type, ArrowType arrowType);

  /**
   * @return the current FieldWriter
   */
  abstract protected FieldWriter getWriter();

  @Override
  public void start() {
    getWriter(MinorType.STRUCT).start();
  }

  @Override
  public void end() {
    getWriter(MinorType.STRUCT).end();
    setPosition(idx() + 1);
  }

  @Override
  public void startList() {
    getWriter(MinorType.LIST).startList();
  }

  @Override
  public void endList() {
    getWriter(MinorType.LIST).endList();
    setPosition(idx() + 1);
  }

  @Override
  public void startMap() {
    getWriter(MinorType.MAP).startMap();
  }

  @Override
  public void endMap() {
    getWriter(MinorType.MAP).endMap();
    setPosition(idx() + 1);
  }

  @Override
  public void startEntry() {
    getWriter(MinorType.MAP).startEntry();
  }

  @Override
  public MapWriter key() {
    return getWriter(MinorType.MAP).key();
  }

  @Override
  public MapWriter value() {
    return getWriter(MinorType.MAP).value();
  }

  @Override
  public void endEntry() {
    getWriter(MinorType.MAP).endEntry();
  }

  <#list vv.types as type><#list type.minor as minor><#assign name = minor.class?cap_first />
    <#assign fields = minor.fields!type.fields />
  <#if minor.class != "Decimal" && minor.class != "Decimal256">
  @Override
  public void write(${name}Holder holder) {
    getWriter(MinorType.${name?upper_case}).write(holder);
  }

  public void write${minor.class}(<#list fields as field>${field.type} ${field.name}<#if field_has_next>, </#if></#list>) {
    getWriter(MinorType.${name?upper_case}).write${minor.class}(<#list fields as field>${field.name}<#if field_has_next>, </#if></#list>);
  }

  <#elseif minor.class == "Decimal">
  @Override
  public void write(DecimalHolder holder) {
    getWriter(MinorType.DECIMAL).write(holder);
  }

  public void writeDecimal(int start, ArrowBuf buffer, ArrowType arrowType) {
    getWriter(MinorType.DECIMAL).writeDecimal(start, buffer, arrowType);
  }

  public void writeDecimal(int start, ArrowBuf buffer) {
    getWriter(MinorType.DECIMAL).writeDecimal(start, buffer);
  }

  public void writeBigEndianBytesToDecimal(byte[] value, ArrowType arrowType) {
    getWriter(MinorType.DECIMAL).writeBigEndianBytesToDecimal(value, arrowType);
  }

  public void writeBigEndianBytesToDecimal(byte[] value) {
    getWriter(MinorType.DECIMAL).writeBigEndianBytesToDecimal(value);
  }
  <#elseif minor.class == "Decimal256">
  @Override
  public void write(Decimal256Holder holder) {
    getWriter(MinorType.DECIMAL256).write(holder);
  }

  public void writeDecimal256(long start, ArrowBuf buffer, ArrowType arrowType) {
    getWriter(MinorType.DECIMAL256).writeDecimal256(start, buffer, arrowType);
  }

  public void writeDecimal256(long start, ArrowBuf buffer) {
    getWriter(MinorType.DECIMAL256).writeDecimal256(start, buffer);
  }
  public void writeBigEndianBytesToDecimal256(byte[] value, ArrowType arrowType) {
    getWriter(MinorType.DECIMAL256).writeBigEndianBytesToDecimal256(value, arrowType);
  }

  public void writeBigEndianBytesToDecimal256(byte[] value) {
    getWriter(MinorType.DECIMAL256).writeBigEndianBytesToDecimal256(value);
  }


  </#if>

  </#list></#list>
  public void writeNull() {
  }

  @Override
  public StructWriter struct() {
    return getWriter(MinorType.LIST).struct();
  }

  @Override
  public ListWriter list() {
    return getWriter(MinorType.LIST).list();
  }

  @Override
  public MapWriter map() {
    return getWriter(MinorType.LIST).map();
  }

  @Override
  public MapWriter map(boolean keysSorted) {
    return getWriter(MinorType.MAP, new ArrowType.Map(keysSorted));
  }

  @Override
  public StructWriter struct(String name) {
    return getWriter(MinorType.STRUCT).struct(name);
  }

  @Override
  public ListWriter list(String name) {
    return getWriter(MinorType.STRUCT).list(name);
  }

  @Override
  public MapWriter map(String name) {
    return getWriter(MinorType.STRUCT).map(name);
  }

  @Override
  public MapWriter map(String name, boolean keysSorted) {
    return getWriter(MinorType.STRUCT).map(name, keysSorted);
  }
  <#list vv.types as type><#list type.minor as minor>
  <#assign lowerName = minor.class?uncap_first />
  <#if lowerName == "int" ><#assign lowerName = "integer" /></#if>
  <#assign upperName = minor.class?upper_case />
  <#assign capName = minor.class?cap_first />

  <#if minor.typeParams?? >
  @Override
  public ${capName}Writer ${lowerName}(String name<#list minor.typeParams as typeParam>, ${typeParam.type} ${typeParam.name}</#list>) {
    return getWriter(MinorType.STRUCT).${lowerName}(name<#list minor.typeParams as typeParam>, ${typeParam.name}</#list>);
  }

  </#if>
  @Override
  public ${capName}Writer ${lowerName}(String name) {
    return getWriter(MinorType.STRUCT).${lowerName}(name);
  }

  @Override
  public ${capName}Writer ${lowerName}() {
    return getWriter(MinorType.LIST).${lowerName}();
  }

  </#list></#list>

  public void copyReader(FieldReader reader) {
    getWriter().copyReader(reader);
  }

  public void copyReaderToField(String name, FieldReader reader) {
    getWriter().copyReaderToField(name, reader);
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