import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AnchoredToastProvider, ToastProvider } from '@/components/ui/toast';
import './index.css';
import App from './App.tsx';

const queryClient = new QueryClient();

const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkMediaQuery.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('dark', e.matches);
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <ToastProvider>
                    <AnchoredToastProvider>
                        <App />
                    </AnchoredToastProvider>
                </ToastProvider>
            </BrowserRouter>
        </QueryClientProvider>
    </StrictMode>
);
