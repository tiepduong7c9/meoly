import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </Theme>
  );
}
