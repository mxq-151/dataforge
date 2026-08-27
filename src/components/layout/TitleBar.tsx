import React from 'react';
import './TitleBar.css';

/**
 * 应用内标题栏（跨平台）。
 * macOS: titleBarStyle=hiddenInset，系统渲染左侧红绿灯，本组件左侧留白。
 * Windows/Linux: titleBarOverlay，系统渲染右侧控制按钮，本组件右侧留白。
 * 拖拽区域由外层 data-electron-drag-region（→ index.html 的 -webkit-app-region）提供。
 */

const TitleBar: React.FC<{ title?: string }> = ({ title = 'dataforge' }) => {
  return (
    <div className="title-bar" data-electron-drag-region>
      {/* macOS: 左侧为系统红绿灯预留空间；Windows/Linux: 右侧为系统按钮预留空间 */}
      <div className="title-bar__left" />
      <div className="title-bar__center" data-electron-drag-region>
        <span className="title-bar__title">{title}</span>
      </div>
      <div className="title-bar__right" />
    </div>
  );
};

export default TitleBar;