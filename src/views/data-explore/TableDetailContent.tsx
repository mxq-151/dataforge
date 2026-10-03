/**
 * 表详情内容（数据探索 与 资产目录 共用）
 *
 * ── 为什么独立成组件 ────────────────────────────────────────
 * 两处入口对「一张表长什么样」的展示必须一致：数据探索从库表浏览器点表弹窗看，
 * 资产目录从目录树选表在右栏看。若各写一份，字段口径与样式会随时间漂移。
 * 这里收敛为唯一实现，两个入口只负责「取数 + 映射到 TableDetailData」。
 *
 * ── 数据形态 ────────────────────────────────────────────────
 * 两处的取数接口不同：
 * - 数据探索：GET /api/metadata/table/columns + GET /api/metadata/tables；
 * - 资产目录：GET /api/asset/table/{id}。
 * 字段语义同源于 table_metadata，故统一映射成本文件的 TableDetailData 后再渲染。
 *
 * ── 样式 ────────────────────────────────────────────────────
 * 复用 TableDetail.css 的 table-detail-modal__* 类（弹窗与右栏共用同一套视觉）。
 * 非模态承载方（资产目录右栏）只需在自身样式里放开定高与裁剪，不改本文件。
 */

import React from 'react';
import './TableDetail.css';

/** 字段行（统一为布尔语义，避免 0/1 与 true/false 两种写法在两处各写一遍） */
export interface TableDetailColumnItem {
  id?: number;
  columnName: string;
  columnType: string;
  columnComment: string;
  isPartition: boolean;
  isPrimaryKey: boolean;
  nullable: boolean;
}

/** 表详情统一数据形态 */
export interface TableDetailData {
  storageEngine: string;
  storageFormat: string;
  /** 压缩方式，源表未提供时为 null */
  compression: string | null;
  tableComment: string;
  location: string;
  hotDays: number;
  coldDays: number;
  keepDays: number;
  columns: TableDetailColumnItem[];
}

interface TableDetailContentProps {
  detail: TableDetailData;
  /** 基础信息之后的入口专属动作（如资产目录的「修改生命周期」）；数据探索不传 */
  infoActions?: React.ReactNode;
}

const TableDetailContent: React.FC<TableDetailContentProps> = ({ detail, infoActions }) => (
  <>
    <section className="table-detail-modal__info">
      <div className="table-detail-modal__info-row">
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">存储引擎</span>
          <span className="table-detail-modal__value">{detail.storageEngine || '-'}</span>
        </div>
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">存储格式</span>
          <span className="table-detail-modal__value">{detail.storageFormat || '-'}</span>
        </div>
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">压缩方式</span>
          <span className="table-detail-modal__value">{detail.compression ?? '-'}</span>
        </div>
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">表注释</span>
          <span className="table-detail-modal__value">{detail.tableComment || '-'}</span>
        </div>
      </div>

      <div className="table-detail-modal__info-row">
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">热数据天数</span>
          <span className="table-detail-modal__value">{detail.hotDays}</span>
        </div>
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">冷数据天数</span>
          <span className="table-detail-modal__value">{detail.coldDays}</span>
        </div>
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">保留天数</span>
          <span className="table-detail-modal__value">{detail.keepDays}</span>
        </div>
        <div className="table-detail-modal__info-item">
          <span className="table-detail-modal__label">存储位置</span>
          <span className="table-detail-modal__value table-detail-modal__value--truncate" title={detail.location || ''}>
            {detail.location || '-'}
          </span>
        </div>
      </div>

      {infoActions && <div className="table-detail-modal__info-actions">{infoActions}</div>}
    </section>

    <section className="table-detail-modal__columns">
      <h4 className="table-detail-modal__columns-title">字段结构</h4>
      {detail.columns.length > 0 ? (
        <div className="table-detail-modal__columns-table-wrapper">
          <div className="table-detail-modal__columns-scroll-container">
            <table className="table-detail-modal__columns-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>字段名</th>
                  <th>类型</th>
                  <th>注释</th>
                  <th>分区</th>
                  <th>主键</th>
                  <th>可空</th>
                </tr>
              </thead>
              <tbody>
                {detail.columns.map((column, index) => (
                  <tr key={column.id ?? index}>
                    <td>{index + 1}</td>
                    <td>{column.columnName}</td>
                    <td>{column.columnType || '-'}</td>
                    <td className="table-detail-modal__column-comment">{column.columnComment || '-'}</td>
                    <td>{column.isPartition ? '是' : ''}</td>
                    <td>{column.isPrimaryKey ? '是' : ''}</td>
                    <td>{column.nullable ? '是' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="table-detail-modal__empty-columns">暂无字段信息</div>
      )}
    </section>
  </>
);

export default TableDetailContent;
