/**
 * prodDatabaseGuard.test.ts — 生产环境提交的「库环境」闸门
 *
 * 提交调度选生产时必须保证代码里引用的库都是生产库（`_prod` 结尾）：漏判会把测试库带上生产，
 * 误判则会把正常的生产提交堵死。所以这里锁两端：
 * 1. 该拦的拦住：SQL 各语境（from/join/insert/use/建表）、Java 里的 SQL 字符串、多文件
 * 2. 不该拦的别拦：注释与代码头里的示例库名、代码里的普通点号（包名/系统类/字段访问）
 */

import { describe, it, expect } from 'vitest';
import {
  PROD_DB_SUFFIX,
  collectDatabaseRefs,
  findNonProdDatabases,
  isProdDatabase,
  prodDatabaseViolationMessage,
} from './prodDatabaseGuard';

const refs = (code: string) => collectDatabaseRefs(code).map(r => `${r.line}:${r.database}`);

describe('库环境判定', () => {
  it('以 _prod 结尾才是生产库（大小写不敏感）', () => {
    expect(isProdDatabase('ods_olist_prod')).toBe(true);
    expect(isProdDatabase('ODS_OLIST_PROD')).toBe(true);
    expect(isProdDatabase('ods_olist_test')).toBe(false);
    expect(isProdDatabase('ods_olist_gray')).toBe(false);
    expect(isProdDatabase('ods_olist')).toBe(false);
  });
});

describe('库引用识别 — 该拦的拦住', () => {
  it('SQL 的 from / join / insert overwrite / use 都能认出来', () => {
    const sql = [
      'INSERT OVERWRITE TABLE dwd_olist_test.dwd_olist_user_login_d PARTITION (dt = \'${day}\')',
      'SELECT a.user_id',
      'FROM ods_olist_test.ods_olist_user_login_d a',
      'JOIN dim_olist_test.dim_olist_user_d b ON a.user_id = b.user_id',
      "WHERE b.channel = 'app'",
    ].join('\n');
    expect(refs(sql)).toEqual([
      '1:dwd_olist_test',
      '3:ods_olist_test',
      '4:dim_olist_test',
    ]);
  });

  it('use 库名、建表语句与反引号包裹的库名同样识别', () => {
    expect(refs('USE ods_olist_test;')).toEqual(['1:ods_olist_test']);
    expect(refs('create table if not exists ads_olist_gray.ads_report_d (id int);'))
      .toEqual(['1:ads_olist_gray']);
    expect(refs('select * from `dws_olist_test`.`dws_trade_order_d`'))
      .toEqual(['1:dws_olist_test']);
  });

  it('Java/Scala/Python 里写在字符串中的 SQL 一样查（写表 API 也认）', () => {
    expect(refs('spark.sql("select * from ods_olist_gray.ods_olist_order_d")'))
      .toEqual(['1:ods_olist_gray']);
    expect(refs('df.write.insertInto("dwd_olist_test.dwd_olist_order_d");'))
      .toEqual(['1:dwd_olist_test']);
  });

  it('行号指向引用所在行（含空行与多行代码）', () => {
    const code = 'line1\n\n-- 注释\nselect * from ods_olist_test.t\n';
    expect(refs(code)).toEqual(['4:ods_olist_test']);
  });
});

describe('库引用识别 — 不该拦的别拦', () => {
  it('注释与代码头里的示例库名不算真实引用', () => {
    const sql = [
      '/*',
      ' * @备注: 参考 dwd_olist_test.dwd_olist_user_login_d 的写法',
      ' */',
      "-- from ods_olist_gray.ods_olist_order_d",
      '# join dim_olist_test.dim_olist_user_d',
      'select 1;',
    ].join('\n');
    expect(collectDatabaseRefs(sql)).toEqual([]);
  });

  it('代码里的包名、系统类、字段访问等普通点号不误判成库', () => {
    const java = [
      'package TEST.java.ods;',
      'import java.util.List;',
      'public class OdsLoad {',
      '  public void run() { System.out.println(1); }',
      '  int from = config.db.host;',
      '}',
    ].join('\n');
    expect(collectDatabaseRefs(java)).toEqual([]);
  });

  it('未限定库的表名（不写库）不参与判定', () => {
    expect(collectDatabaseRefs('select * from dwd_olist_order_d')).toEqual([]);
  });

  it('以 _prod 结尾的库不报违规', () => {
    const files = [
      { file: 'ods_a.sql', content: 'select * from ods_olist_prod.ods_olist_order_d' },
      { file: 'ods_b.sql', content: 'insert overwrite table dwd_olist_prod.dwd_order_d select 1' },
    ];
    expect(findNonProdDatabases(files)).toEqual([]);
  });
});

describe('非生产库违规报告', () => {
  it('逐文件给出库名与行号，并按行去重', () => {
    const files = [
      { file: 'ods_a.sql', content: 'select * from ods_olist_test.t1\njoin dws_olist_gray.t2 on 1=1' },
      { file: 'ods_b.py', content: 'spark.sql("select * from ods_olist_test.t1")' },
    ];
    const violations = findNonProdDatabases(files);
    expect(violations.map(v => `${v.file}|${v.line}|${v.database}`)).toEqual([
      'ods_a.sql|1|ods_olist_test',
      'ods_a.sql|2|dws_olist_gray',
      'ods_b.py|1|ods_olist_test',
    ]);
  });

  it('缺环境后缀的库也算非生产库', () => {
    const violations = findNonProdDatabases([
      { file: 'ods_a.sql', content: 'select * from ods_olist.ods_olist_order_d' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].database).toBe('ods_olist');
  });

  it('提示文案给出库名、行号与修法（文件夹入口带文件名）', () => {
    const [v] = findNonProdDatabases([
      { file: 'ods_a.sql', content: 'select * from ods_olist_test.ods_olist_order_d' },
    ]);
    expect(prodDatabaseViolationMessage(v)).toContain(`${PROD_DB_SUFFIX}`);
    expect(prodDatabaseViolationMessage(v)).toContain('第 1 行');
    expect(prodDatabaseViolationMessage(v)).toContain('ods_olist_test');
    expect(prodDatabaseViolationMessage(v, true)).toContain('「ods_a.sql」第 1 行');
  });
});