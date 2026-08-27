error id: jar:file://<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/DenseUnionWriter.java
file://<WORKSPACE>/jar:file:<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/DenseUnionWriter.java
### java.lang.Exception: Unexpected symbol '#' at word pos: '35' Line: '    <#list  vv.types as type>'

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

import org.apache.arrow.vector.complex.StructVector;
import org.apache.arrow.vector.complex.impl.NullableStructWriterFactory;
import org.apache.arrow.vector.types.Types;

<@pp.dropOutputFile />
<@pp.changeOutputFile name="/org/apache/arrow/vector/complex/impl/DenseUnionWriter.java" />


<#include "/@includes/license.ftl" />

        package org.apache.arrow.vector.complex.impl;

<#include "/@includes/vv_imports.ftl" />
        import org.apache.arrow.vector.complex.writer.BaseWriter;
        import org.apache.arrow.vector.types.Types.MinorType;

/*
 * This class is generated using freemarker and the ${.template_name} template.
 */
@SuppressWarnings("unused")
public class DenseUnionWriter extends AbstractFieldWriter implements FieldWriter {

  DenseUnionVector data;

  private BaseWriter[] writers = new BaseWriter[Byte.MAX_VALUE + 1];
  private final NullableStructWriterFactory nullableStructWriterFactory;

  public DenseUnionWriter(DenseUnionVector vector) {
    this(vector, NullableStructWriterFactory.getNullableStructWriterFactoryInstance());
  }

  public DenseUnionWriter(DenseUnionVector vector, NullableStructWriterFactory nullableStructWriterFactory) {
    data = vector;
    this.nullableStructWriterFactory = nullableStructWriterFactory;
  }

  @Override
  public void setPosition(int index) {
    super.setPosition(index);
    for (BaseWriter writer : writers) {
      writer.setPosition(index);
    }
  }

  @Override
  public void start() {
    byte typeId = data.getTypeId(idx());
    getStructWriter((byte) idx()).start();
  }

  @Override
  public void end() {
    byte typeId = data.getTypeId(idx());
    getStructWriter(typeId).end();
  }

  @Override
  public void startList() {
    byte typeId = data.getTypeId(idx());
    getListWriter(typeId).startList();
  }

  @Override
  public void endList() {
    byte typeId = data.getTypeId(idx());
    getListWriter(typeId).endList();
  }

  private StructWriter getStructWriter(byte typeId) {
    StructWriter structWriter = (StructWriter) writers[typeId];
    if (structWriter == null) {
      structWriter = nullableStructWriterFactory.build((StructVector) data.getVectorByType(typeId));
      writers[typeId] = structWriter;
    }
    return structWriter;
  }

  public StructWriter asStruct(byte typeId) {
    data.setTypeId(idx(), typeId);
    return getStructWriter(typeId);
  }

  private ListWriter getListWriter(byte typeId) {
    ListWriter listWriter = (ListWriter) writers[typeId];
    if (listWriter == null) {
      listWriter = new UnionListWriter((ListVector) data.getVectorByType(typeId), nullableStructWriterFactory);
      writers[typeId] = listWriter;
    }
    return listWriter;
  }

  public ListWriter asList(byte typeId) {
    data.setTypeId(idx(), typeId);
    return getListWriter(typeId);
  }

  private MapWriter getMapWriter(byte typeId) {
    MapWriter mapWriter = (MapWriter) writers[typeId];
    if (mapWriter == null) {
      mapWriter = new UnionMapWriter((MapVector) data.getVectorByType(typeId));
      writers[typeId] = mapWriter;
    }
    return mapWriter;
  }

  public MapWriter asMap(byte typeId) {
    data.setTypeId(idx(), typeId);
    return getMapWriter(typeId);
  }

  BaseWriter getWriter(byte typeId) {
    MinorType minorType = data.getVectorByType(typeId).getMinorType();
    switch (minorType) {
      case STRUCT:
        return getStructWriter(typeId);
      case LIST:
        return getListWriter(typeId);
      case MAP:
        return getMapWriter(typeId);
    <#list vv.types as type>
      <#list type.minor as minor>
        <#assign name = minor.class?cap_first />
        <#assign fields = minor.fields!type.fields />
        <#assign uncappedName = name?uncap_first/>
        <#if !minor.typeParams?? || minor.class?starts_with("Decimal")>
      case ${name?upper_case}:
      return get${name}Writer(typeId);
        </#if>
      </#list>
    </#list>
      default:
        throw new UnsupportedOperationException("Unknown type: " + minorType);
    }
  }
  <#list vv.types as type>
    <#list type.minor as minor>
      <#assign name = minor.class?cap_first />
      <#assign fields = minor.fields!type.fields />
      <#assign uncappedName = name?uncap_first/>
      <#if !minor.typeParams?? || minor.class?starts_with("Decimal")>

  private ${name}Writer get${name}Writer(byte typeId) {
    ${name}Writer writer = (${name}Writer) writers[typeId];
    if (writer == null) {
      writer = new ${name}WriterImpl((${name}Vector) data.getVectorByType(typeId));
      writers[typeId] = writer;
    }
    return writer;
  }

  public ${name}Writer as${name}(byte typeId) {
    data.setTypeId(idx(), typeId);
    return get${name}Writer(typeId);
  }

  @Override
  public void write(${name}Holder holder) {
    throw new UnsupportedOperationException();
  }

  public void write${minor.class}(<#list fields as field>${field.type} ${field.name}<#if field_has_next>, </#if></#list>, byte typeId<#if minor.class?starts_with("Decimal")>, ArrowType arrowType</#if>) {
    data.setTypeId(idx(), typeId);
    get${name}Writer(typeId).setPosition(data.getOffset(idx()));
    get${name}Writer(typeId).write${name}(<#list fields as field>${field.name}<#if field_has_next>, </#if></#list><#if minor.class?starts_with("Decimal")>, arrowType</#if>);
  }
      </#if>
    </#list>
  </#list>

  public void writeNull() {
  }

  @Override
  public StructWriter struct() {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getListWriter(typeId).setPosition(data.getOffset(idx()));
    return getListWriter(typeId).struct();
  }

  @Override
  public ListWriter list() {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getListWriter(typeId).setPosition(data.getOffset(idx()));
    return getListWriter(typeId).list();
  }

  @Override
  public ListWriter list(String name) {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getStructWriter(typeId).setPosition(data.getOffset(idx()));
    return getStructWriter(typeId).list(name);
  }

  @Override
  public MapWriter map() {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getListWriter(typeId).setPosition(data.getOffset(idx()));
    return getMapWriter(typeId).map();
  }

  @Override
  public MapWriter map(String name) {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getStructWriter(typeId).setPosition(data.getOffset(idx()));
    return getStructWriter(typeId).map(name);
  }

  @Override
  public MapWriter map(String name, boolean keysSorted) {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getStructWriter(typeId).setPosition(data.getOffset(idx()));
    return getStructWriter(typeId).map(name, keysSorted);
  }

  @Override
  public StructWriter struct(String name) {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getStructWriter(typeId).setPosition(data.getOffset(idx()));
    return getStructWriter(typeId).struct(name);
  }

  <#list vv.types as type><#list type.minor as minor>
  <#assign lowerName = minor.class?uncap_first />
  <#if lowerName == "int" ><#assign lowerName = "integer" /></#if>
  <#assign upperName = minor.class?upper_case />
  <#assign capName = minor.class?cap_first />
  <#if !minor.typeParams?? || minor.class?starts_with("Decimal") >
  @Override
  public ${capName}Writer ${lowerName}(String name) {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getStructWriter(typeId).setPosition(data.getOffset(idx()));
    return getStructWriter(typeId).${lowerName}(name);
  }

  @Override
  public ${capName}Writer ${lowerName}() {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getListWriter(typeId).setPosition(data.getOffset(idx()));
    return getListWriter(typeId).${lowerName}();
  }
  </#if>
  <#if minor.class?starts_with("Decimal")>
  public ${capName}Writer ${lowerName}(String name<#list minor.typeParams as typeParam>, ${typeParam.type} ${typeParam.name}</#list>) {
    byte typeId = data.getTypeId(idx());
    data.setTypeId(idx(), typeId);
    getStructWriter(typeId).setPosition(data.getOffset(idx()));
    return getStructWriter(typeId).${lowerName}(name<#list minor.typeParams as typeParam>, ${typeParam.name}</#list>);
  }
  </#if>
  </#list></#list>

  @Override
  public void allocate() {
    data.allocateNew();
  }

  @Override
  public void clear() {
    data.clear();
  }

  @Override
  public void close() throws Exception {
    data.close();
  }

  @Override
  public Field getField() {
    return data.getField();
  }

  @Override
  public int getValueCapacity() {
    return data.getValueCapacity();
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