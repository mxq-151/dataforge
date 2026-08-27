error id: jar:file://<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/HolderReaderImpl.java
file://<WORKSPACE>/jar:file:<HOME>/.m2/repository/org/apache/arrow/arrow-vector/12.0.1/arrow-vector-12.0.1-sources.jar!/codegen/templates/HolderReaderImpl.java
### java.lang.Exception: Unexpected symbol '#' at word pos: '35' Line: '<#list  vv.types as type>'

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
<#list vv.types as type>
<#list type.minor as minor>
<#list ["", "Nullable"] as holderMode>
<#assign nullMode = holderMode />

<#assign lowerName = minor.class?uncap_first />
<#if lowerName == "int" ><#assign lowerName = "integer" /></#if>
<#assign name = minor.class?cap_first />
<#assign javaType = (minor.javaType!type.javaType) />
<#assign friendlyType = (minor.friendlyType!minor.boxedType!type.boxedType) />
<#assign safeType=friendlyType />
<#if safeType=="byte[]"><#assign safeType="ByteArray" /></#if>
<#assign fields = (minor.fields!type.fields) + minor.typeParams![]/>

<@pp.changeOutputFile name="/org/apache/arrow/vector/complex/impl/${holderMode}${name}HolderReaderImpl.java" />
<#include "/@includes/license.ftl" />

package org.apache.arrow.vector.complex.impl;

<#include "/@includes/vv_imports.ftl" />

// Source code generated using FreeMarker template ${.template_name}

@SuppressWarnings("unused")
public class ${holderMode}${name}HolderReaderImpl extends AbstractFieldReader {

  private ${nullMode}${name}Holder holder;
  public ${holderMode}${name}HolderReaderImpl(${holderMode}${name}Holder holder) {
    this.holder = holder;
  }

  @Override
  public int size() {
    throw new UnsupportedOperationException("You can't call size on a Holder value reader.");
  }

  @Override
  public boolean next() {
    throw new UnsupportedOperationException("You can't call next on a single value reader.");

  }

  @Override
  public void setPosition(int index) {
    throw new UnsupportedOperationException("You can't call next on a single value reader.");
  }

  @Override
  public MinorType getMinorType() {
        return MinorType.${name?upper_case};
  }

  @Override
  public boolean isSet() {
    <#if holderMode == "Nullable">
    return this.holder.isSet == 1;
    <#else>
    return true;
    </#if>
  }

  @Override
  public void read(${name}Holder h) {
  <#list fields as field>
    h.${field.name} = holder.${field.name};
  </#list>
  }

  @Override
  public void read(Nullable${name}Holder h) {
  <#list fields as field>
    h.${field.name} = holder.${field.name};
  </#list>
    h.isSet = isSet() ? 1 : 0;
  }

  // read friendly type
  @Override
  public ${friendlyType} read${safeType}() {
  <#if nullMode == "Nullable">
    if (!isSet()) {
      return null;
    }
  </#if>

  <#if type.major == "VarLen">
    <#if type.width == 4>
    int length = holder.end - holder.start;
    <#elseif type.width == 8>
    int length = (int) (holder.end - holder.start);
    </#if>
    byte[] value = new byte [length];
    holder.buffer.getBytes(holder.start, value, 0, length);
    <#if minor.class == "VarBinary" || minor.class == "LargeVarBinary">
    return value;
    <#elseif minor.class == "VarChar" || minor.class == "LargeVarChar">
    Text text = new Text();
    text.set(value);
    return text;
    </#if>
  <#elseif minor.class == "IntervalDay">
    return Duration.ofDays(holder.days).plusMillis(holder.milliseconds);
  <#elseif minor.class == "IntervalYear">
    return Period.ofMonths(holder.value);
  <#elseif minor.class == "IntervalMonthDayNano">
    return new PeriodDuration(Period.ofMonths(holder.months).plusDays(holder.days),
        Duration.ofNanos(holder.nanoseconds));
  <#elseif minor.class == "Duration">
    return DurationVector.toDuration(holder.value, holder.unit);
  <#elseif minor.class == "Bit" >
    return new Boolean(holder.value != 0);
  <#elseif minor.class == "Decimal">
    byte[] bytes = new byte[${type.width}];
    holder.buffer.getBytes(holder.start, bytes, 0, ${type.width});
    ${friendlyType} value = new BigDecimal(new BigInteger(bytes), holder.scale);
    return value;
  <#elseif minor.class == "Decimal256">
    byte[] bytes = new byte[${type.width}];
    holder.buffer.getBytes(holder.start, bytes, 0, ${type.width});
    ${friendlyType} value = new BigDecimal(new BigInteger(bytes), holder.scale);
    return value;
  <#elseif minor.class == "FixedSizeBinary">
    byte[] value = new byte [holder.byteWidth];
    holder.buffer.getBytes(0, value, 0, holder.byteWidth);
    return value;
  <#elseif minor.class == "TimeStampSec">
    final long millis = java.util.concurrent.TimeUnit.SECONDS.toMillis(holder.value);
    return DateUtility.getLocalDateTimeFromEpochMilli(millis);
  <#elseif minor.class == "TimeStampMilli" || minor.class == "DateMilli" || minor.class == "TimeMilli">
    return DateUtility.getLocalDateTimeFromEpochMilli(holder.value);
  <#elseif minor.class == "TimeStampMicro">
    return DateUtility.getLocalDateTimeFromEpochMicro(holder.value);
  <#elseif minor.class == "TimeStampNano">
    return DateUtility.getLocalDateTimeFromEpochNano(holder.value);
  <#else>
    ${friendlyType} value = new ${friendlyType}(this.holder.value);
    return value;
  </#if>
  }

  @Override
  public Object readObject() {
    return read${safeType}();
  }

  <#if nullMode != "Nullable">
  public void copyAsValue(${minor.class?cap_first}Writer writer){
    writer.write(holder);
  }
  </#if>
}

</#list>
</#list>
</#list>

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