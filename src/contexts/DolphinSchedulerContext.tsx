import React, { createContext, useContext, useMemo } from 'react';
import type { DolphinSchedulerApi } from '../types/dolphinscheduler';
import { createRealDolphinSchedulerApi } from '../api/dolphinscheduler';

interface DolphinSchedulerContextValue {
  api: DolphinSchedulerApi | null;
  isRealApi: boolean;
}

const DolphinSchedulerContext = createContext<DolphinSchedulerContextValue>({
  api: null,
  isRealApi: false,
});

export const DolphinSchedulerProvider: React.FC<{
  apiUrl?: string;
  token?: string;
  children: React.ReactNode;
}> = ({ apiUrl, token, children }) => {
  const value = useMemo<DolphinSchedulerContextValue>(() => {
    if (apiUrl && token) {
      return {
        api: createRealDolphinSchedulerApi(apiUrl, token),
        isRealApi: true,
      };
    }
    return {
      api: null,
      isRealApi: false,
    };
  }, [apiUrl, token]);

  return (
    <DolphinSchedulerContext.Provider value={value}>
      {children}
    </DolphinSchedulerContext.Provider>
  );
};

export function useDolphinSchedulerApi(): DolphinSchedulerContextValue {
  return useContext(DolphinSchedulerContext);
}
