import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { XCircle, AlertCircle } from 'lucide-react';
import { setApiErrorHandler } from '../api/index';
import './Toast.css';

interface ToastItem {
  id: number;
  message: string;
  type: 'error' | 'warning' | 'info';
}

interface ToastContextValue {
  error: (message: string) => void;
  warning: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastId = 0;

// 错误提示停留时间更长，便于用户看清报错内容
const ERROR_TOAST_DURATION = 3500;
const DEFAULT_DURATION = 2000;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const addToast = useCallback((message: string, type: ToastItem['type'] = 'error', duration = type === 'error' ? ERROR_TOAST_DURATION : DEFAULT_DURATION) => {
    const id = ++toastId;
    setToasts(prev => [...prev, { id, message, type }]);

    const timer = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      timersRef.current.delete(id);
    }, duration);
    timersRef.current.set(id, timer);
  }, []);

  useEffect(() => {
    setApiErrorHandler((msg) => addToast(msg, 'error'));
    return () => setApiErrorHandler(null);
  }, [addToast]);

  const removeToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // 关键：value 必须 memoize。否则每次渲染 value 都是新对象，所有 useToast()
  // 消费者拿到的 toast 引用每帧都变，会导致依赖 [toast] 的 effect 反复
  // cleanup + 重注册。曾导致 DevAssistantView 的 definitionOpener 在每次渲染
  // 先被置 null 再重注册，跳转若落在该窗口期 → 跨文件目标被丢弃 →「无响应」。
  const value: ToastContextValue = useMemo(() => ({
    error: (msg: string) => addToast(msg, 'error'),
    warning: (msg: string) => addToast(msg, 'warning'),
    info: (msg: string) => addToast(msg, 'info'),
  }), [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast toast--${toast.type}`} onClick={() => removeToast(toast.id)}>
            {toast.type === 'error' ? <AlertCircle size={14} /> : <XCircle size={14} />}
            <span className="toast__message">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export default ToastContext;
