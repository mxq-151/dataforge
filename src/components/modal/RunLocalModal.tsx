import { useEffect, useState } from 'react';
import { Play, Terminal, X } from 'lucide-react';
import './RunLocalModal.css';

export interface RunLocalConfig {
  mainClass: string;
  vmArgs: string;
  programArgs: string;
}

interface RunLocalModalProps {
  open: boolean;
  /** 默认主类（编译结果） */
  defaultMainClass: string;
  /** 默认程序参数（预填） */
  defaultArgs: string;
  onRun: (cfg: RunLocalConfig) => void;
  onCancel: () => void;
}

export function RunLocalModal({ open, defaultMainClass, defaultArgs, onRun, onCancel }: RunLocalModalProps) {
  const [mainClass, setMainClass] = useState(defaultMainClass);
  const [vmArgs, setVmArgs] = useState('');
  const [programArgs, setProgramArgs] = useState(defaultArgs);

  // 每次打开时用编译结果与默认参数重置表单
  useEffect(() => {
    if (open) {
      setMainClass(defaultMainClass);
      setVmArgs('');
      setProgramArgs(defaultArgs);
    }
  }, [open, defaultMainClass, defaultArgs]);

  if (!open) return null;

  const handleRun = () => {
    onRun({ mainClass, vmArgs, programArgs });
  };

  return (
    <div className="run-local-overlay" onClick={() => onCancel()}>
      <div className="run-local-modal" onClick={(e) => e.stopPropagation()}>
        <header className="run-local__header">
          <div className="run-local__title">
            <Terminal size={18} />
            <span>本地运行配置</span>
          </div>
          <button className="run-local__close" onMouseDown={(e) => { e.preventDefault(); onCancel(); }}>
            <X size={16} />
          </button>
        </header>

        <div className="run-local__body">
          <div className="run-local__field">
            <label className="run-local__label">主类（Main class）</label>
            <input
              className="run-local__input"
              value={mainClass}
              onChange={(e) => setMainClass(e.target.value)}
              placeholder="留空则运行时自动识别"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="run-local__field">
            <label className="run-local__label">程序参数（Program arguments）</label>
            <input
              className="run-local__input"
              value={programArgs}
              onChange={(e) => setProgramArgs(e.target.value)}
              placeholder="--key value arg1 arg2"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="run-local__field">
            <label className="run-local__label">VM 参数（VM options）</label>
            <input
              className="run-local__input"
              value={vmArgs}
              onChange={(e) => setVmArgs(e.target.value)}
              placeholder="-Xmx1g -Dfile.encoding=UTF-8"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>

        <footer className="run-local__footer">
          <button className="run-local__btn run-local__btn--ghost" onClick={() => onCancel()}>取消</button>
          <button className="run-local__btn run-local__btn--primary" onClick={handleRun}>
            <Play size={14} />
            <span>运行</span>
          </button>
        </footer>
      </div>
    </div>
  );
}